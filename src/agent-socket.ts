import { hostname } from 'node:os';
import {
  PROTOCOL_VERSION,
  isCompatible,
  parseDispatchMessage,
  type AgentIdentity,
  type ServerToDispatch,
  type DispatchToServer,
  type WireCandidate,
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
  log: (level: 'info' | 'warning', message: string) => void;
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
}

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

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

  /** Close everything; used on shutdown. */
  stop(): void {
    this.closing = true;
    for (const id of [...this.open.keys()]) this.withdraw(id, 'shutdown');
    this.disconnect();
  }

  private identity(): AgentIdentity {
    return {
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
    if (this.socket || this.refused || this.closing) return;

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
      this.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, agent: this.identity() });
    });

    socket.addEventListener('message', event => {
      const message = parseDispatchMessage(typeof event.data === 'string' ? event.data : String(event.data));
      if (message) void this.handle(message);
    });

    socket.addEventListener('error', () => {
      // 'close' always follows; retrying is handled there.
    });

    socket.addEventListener('close', () => {
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
        // Re-offer everything: this may be a reconnect.
        for (const request of this.open.values()) this.send({ type: 'request', ...request });
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
