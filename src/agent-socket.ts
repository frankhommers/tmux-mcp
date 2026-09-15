import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { tmuxServerFingerprint } from './tmux.js';
import {
  PROTOCOL_VERSION,
  isCompatible,
  parseDispatchMessage,
  type AgentIdentity,
  type ServerToDispatch,
  type DispatchToServer,
  type WireCandidate,
  type WireGrant,
} from './protocol.js';

/**
 * The MCP server's side of the dispatch connection.
 *
 * It dials out and holds the socket only while requests are open, so nothing
 * on this machine listens and an idle agent keeps no connection. Everything
 * tmux-shaped stays here: dispatch is told what the candidates are and can only
 * name one back, which this side then validates.
 */

export interface AgentSocketOptions {
  url: string;
  token?: string;
  scope: string;
  clientVersion: string;
  /** Called when dispatch answers. Returns what became of that answer. */
  onAnswer: (id: string, answer: { target: string } | { deny: true; reason?: string })
    => Promise<{ ok: true; target: string } | { ok: false; error: string }>;
  /** Called when dispatch asks for a fresh candidate list. */
  onRefresh: (id: string) => Promise<WireCandidate[]>;
  /** The grants held right now, reported by `reportGrants`. */
  /** The name the MCP client gave in its handshake, so a human can tell agents apart. */
  mcpClient?: () => string | undefined;
  listGrants?: () => WireGrant[];
  /** Take a grant back. Returns whether anything was actually held. */
  onRevoke?: (target: string) => boolean | Promise<boolean>;
  log: (level: 'info' | 'warning', message: string) => void;
  /**
   * How long to stay after reporting grants, so dispatch can push commands
   * that were queued while this agent was away. Kept short: the connection
   * exists to carry a change, not to be held open.
   */
  lingerMs?: number;
  /** How long to wait for a verdict before falling back to the local grant. */
  confirmTimeoutMs?: number;
  /** Test seam. */
  connect?: (url: string, token?: string) => WebSocket;
}

interface OpenRequest {
  id: string;
  reason: string;
  kind: 'pane' | 'window';
  createdAt: number;
  expiresAt: number;
  candidates: WireCandidate[];
  suggested?: string;
}

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const LINGER_MS = 1000;
const CONFIRM_TIMEOUT_MS = 1500;

function defaultConnect(url: string, token?: string): WebSocket {
  // Node's WebSocket takes headers through a non-standard option bag; the DOM
  // type does not describe it, hence the cast.
  const options = token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
  return new (WebSocket as unknown as new (u: string, o?: unknown) => WebSocket)(url, options);
}

export class AgentSocket {
  private socket: WebSocket | null = null;
  private readonly open = new Map<string, OpenRequest>();
  private backoff = BACKOFF_START_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private handshaken = false;
  /** Set when dispatch refused us: retrying would just be refused again. */
  private refused = false;
  private closing = false;
  /** A grant report is owed to dispatch as soon as the handshake lands. */
  private reporting = false;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingChecks = new Map<string, (allowed: boolean) => void>();

  private readonly instanceId = randomUUID();

  constructor(private readonly options: AgentSocketOptions) {}

  /** True once dispatch has accepted the handshake. */
  get connected(): boolean {
    return this.handshaken && this.socket?.readyState === 1;
  }

  /** True when dispatch told us to go away; the caller should use the file path. */
  get givenUp(): boolean {
    return this.refused;
  }

  /** Offer a request to dispatch, connecting if this is the first one. */
  offer(request: OpenRequest): void {
    if (this.refused) return;
    this.open.set(request.id, request);
    if (this.connected) this.send({ type: 'request', ...request });
    else this.ensureConnection();
  }

  /** The request is settled or gone; tell dispatch and drop the socket if idle. */
  withdraw(id: string, why: 'expired' | 'answered_elsewhere' | 'shutdown'): void {
    if (!this.open.delete(id)) return;
    if (this.connected) this.send({ type: 'withdraw', id, why });
    if (this.open.size === 0) this.disconnect();
  }

  /**
   * Tell dispatch what is granted now. An idle agent holds no socket, so this
   * dials in, reports, and hangs up again unless a request keeps it open.
   */
  reportGrants(): void {
    if (this.refused || this.closing) return;
    this.reporting = true;
    if (this.connected) this.flushGrants();
    else this.ensureConnection();
  }

  /**
   * Ask dispatch whether a target this server still holds may be used right
   * now. A human who revokes in the UI is obeyed at the next action rather
   * than at the next reconnect.
   *
   * Falls back to `true` when dispatch cannot be reached: the local grant
   * store already refused everything that was never handed over, and a dead
   * dispatch must not take away access a human deliberately gave.
   */
  async confirm(target: string): Promise<boolean> {
    if (this.refused || this.closing) return true;
    if (!this.connected) {
      this.ensureConnection();
      const ready = await this.waitForHandshake();
      if (!ready) return true;
    }
    const id = randomUUID();
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => {
        this.pendingChecks.delete(id);
        this.options.log('warning', `dispatch did not answer about ${target}; using the local grant`);
        resolve(true);
      }, this.options.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS);
      timer.unref?.();
      this.pendingChecks.set(id, allowed => {
        clearTimeout(timer);
        // A refusal is a revoke we happened to learn about by asking, so it
        // costs us the grant just the same.
        if (!allowed) {
          this.options.onRevoke?.(target);
          this.reportGrants();
        }
        resolve(allowed);
      });
      this.send({ type: 'check', id, target });
      this.lingerThenHangUp();
    });
  }

  private async waitForHandshake(): Promise<boolean> {
    const deadline = Date.now() + (this.options.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (this.connected) return true;
      if (this.refused || this.closing) return false;
      await new Promise(r => setTimeout(r, 20));
    }
    return false;
  }

  /** Close everything; used on shutdown. */
  stop(): void {
    // Grants live in this process's memory, so they end with it. Say so while
    // the socket is still up, or dispatch would keep showing a pane nobody
    // holds. There is no dialling in for this: shutdown must not block.
    if (this.connected && !this.closing) this.send({ type: 'grants', grants: [] });
    this.closing = true;
    for (const id of [...this.open.keys()]) this.withdraw(id, 'shutdown');
    this.disconnect();
  }

  private async identity(): Promise<AgentIdentity> {
    return {
      instanceId: this.instanceId,
      tmuxServer: await tmuxServerFingerprint().catch(() => undefined),
      mcpClient: this.options.mcpClient?.(),
      pid: process.pid,
      host: hostname(),
      cwd: process.cwd(),
      tmuxSession: process.env.TMUX ? (process.env.TMUX_PANE ?? null) : null,
      scope: this.options.scope,
      client: this.options.clientVersion,
    };
  }

  private send(message: ServerToDispatch): void {
    try {
      this.socket?.send(JSON.stringify(message));
    } catch (error) {
      this.options.log('warning', `could not send ${message.type}: ${(error as Error).message}`);
    }
  }

  private ensureConnection(): void {
    if (this.refused || this.closing) return;
    // A socket that is closing cannot carry anything any more, and its close
    // event has not run yet. Dial past it rather than wait on a dead line.
    if (this.socket && this.socket.readyState <= 1) return;

    const connect = this.options.connect ?? defaultConnect;
    let socket: WebSocket;
    try {
      socket = connect(this.options.url, this.options.token);
    } catch (error) {
      this.options.log('warning', `dispatch service unreachable: ${(error as Error).message}`);
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    this.handshaken = false;

    socket.addEventListener('open', () => {
      // Read per connection rather than once at startup: tmux can restart under
      // a long-lived server, and a stale fingerprint would let a standing rule
      // hand out an id that no longer means what a human decided it meant.
      void this.identity().then(agent => {
        this.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, agent });
      });
    });

    socket.addEventListener('message', event => {
      const message = parseDispatchMessage(typeof event.data === 'string' ? event.data : String(event.data));
      if (message) void this.handle(message);
    });

    socket.addEventListener('error', () => {
      // 'close' always follows; retrying is handled there.
    });

    socket.addEventListener('close', () => {
      // A newer socket may already have taken over; its state is not ours to clear.
      if (this.socket !== socket) return;
      const wasHandshaken = this.handshaken;
      this.socket = null;
      this.handshaken = false;
      if (this.closing || this.refused || this.open.size === 0) return;
      if (wasHandshaken) this.options.log('info', 'dispatch service connection lost, reconnecting');
      this.scheduleRetry();
    });
  }

  private async handle(message: DispatchToServer): Promise<void> {
    switch (message.type) {
      case 'welcome': {
        if (!isCompatible(message.protocolVersion)) {
          this.giveUp(
            `dispatch service speaks protocol ${message.protocolVersion}, this server speaks ${PROTOCOL_VERSION}; ` +
            'update the older side. Falling back to `tmux-mcp grant`.'
          );
          return;
        }
        this.handshaken = true;
        this.backoff = BACKOFF_START_MS;
        // Re-offer everything: this may be a reconnect, and dispatch may have
        // restarted with an empty head since we last spoke.
        for (const request of this.open.values()) this.send({ type: 'request', ...request });
        this.flushGrants();
        return;
      }

      case 'refuse': {
        this.giveUp(
          message.reason === 'protocol_version'
            ? `dispatch service refused protocol ${PROTOCOL_VERSION} (it speaks ${message.protocolVersion ?? 'unknown'}). ` +
              'Falling back to `tmux-mcp grant`.'
            : 'dispatch service refused this device. Pair it again, or use `tmux-mcp grant`.'
        );
        return;
      }

      case 'refresh': {
        if (!this.open.has(message.id)) return;
        const candidates = await this.options.onRefresh(message.id);
        const request = this.open.get(message.id);
        if (request) request.candidates = candidates;
        this.send({ type: 'candidates', id: message.id, candidates });
        return;
      }

      case 'verdict': {
        const settle = this.pendingChecks.get(message.id);
        if (settle) {
          this.pendingChecks.delete(message.id);
          settle(message.allowed);
        }
        return;
      }

      case 'revoke': {
        const revoked = await this.options.onRevoke?.(message.target);
        // Report either way: dispatch's picture was wrong if nothing was held,
        // and this is what corrects it.
        if (revoked !== undefined) this.reportGrants();
        return;
      }

      case 'answer': {
        if (!this.open.has(message.id)) return;
        const answer = 'target' in message
          ? { target: message.target }
          : { deny: true as const, reason: message.reason };
        const outcome = await this.options.onAnswer(message.id, answer);
        this.send(outcome.ok
          ? { type: 'result', id: message.id, ok: true, target: outcome.target }
          : { type: 'result', id: message.id, ok: false, error: outcome.error });
        return;
      }
    }
  }

  private flushGrants(): void {
    this.reporting = false;
    this.send({ type: 'grants', grants: this.options.listGrants?.() ?? [] });
    this.lingerThenHangUp();
  }

  /** Give dispatch a moment to push queued commands, then drop an idle socket. */
  private lingerThenHangUp(): void {
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      if (this.open.size === 0 && !this.reporting) this.disconnect();
    }, this.options.lingerMs ?? LINGER_MS);
    this.lingerTimer.unref?.();
  }

  private giveUp(message: string): void {
    this.refused = true;
    this.options.log('warning', message);
    this.disconnect();
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.open.size > 0) this.ensureConnection();
    }, delay);
    this.retryTimer.unref?.();
  }

  private disconnect(): void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.handshaken = false;
    try { socket?.close(); } catch { /* already closed */ }
  }
}
