/**
 * Control-mode watcher for tmux resource-change notifications.
 *
 * Spawns a long-lived `tmux -C attach` child process and parses its
 * notification stream to detect structural changes (session/window/pane
 * create/close/rename/layout). On change, calls the supplied callback
 * (debounced) so the MCP server can emit `notifications/resources/list_changed`.
 *
 * Falls back to polling when `$TMUX` is unset or attach is not possible.
 * `%output` notifications are suppressed via `refresh-client -F +no-output`
 * (tmux >= 3.2) and additionally filtered defensively in the parser.
 *
 * Reconnects with exponential backoff (1s -> 2s -> 5s cap) on child exit.
 */

import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import * as tmux from './tmux.js';
import { getScopeMode, getAllowedSessionIds } from './scope.js';

export interface WatcherCallbacks {
  /** Called (debounced) when the resource list may have changed. */
  onListChanged: () => void;
  /** Optional logger for diagnostics. */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

interface ParsedTmux {
  socket?: string;
  sessionId?: string; // e.g. "$3"
}

/**
 * Parse $TMUX env var (format: `socket_path,server_pid,session_id_numeric`).
 * Returns the socket path and session id (with `$` prefix), if present.
 */
function parseTmuxEnv(): ParsedTmux {
  const raw = process.env.TMUX;
  if (!raw) return {};
  const parts = raw.split(',');
  if (parts.length < 3) return {};
  const socket = parts[0] || undefined;
  const sidNum = parts[2];
  const sessionId = sidNum ? `$${sidNum}` : undefined;
  return { socket, sessionId };
}

/** Pick the best target session id to attach to. */
async function pickTargetSession(): Promise<string | null> {
  // Prefer scope's allowed session (if scope is active and one exists).
  if (getScopeMode() !== 'none') {
    const allowed = getAllowedSessionIds();
    const first = allowed.values().next();
    if (!first.done && typeof first.value === 'string') return first.value;
  }
  // Otherwise, the session we're embedded in (from $TMUX).
  const fromEnv = parseTmuxEnv().sessionId;
  if (fromEnv) return fromEnv;
  // Otherwise, the first session on the (default) tmux server.
  try {
    const sessions = await tmux.listSessions();
    if (sessions.length > 0) return sessions[0].id;
  } catch {
    // tmux server may not be running yet
  }
  return null;
}

/**
 * Notification names from tmux control mode that imply the resource list
 * (sessions/windows/panes) may have changed. We listen for these and ignore
 * everything else (especially %output, which is suppressed via no-output flag
 * but we drop defensively as well).
 */
const STRUCTURAL_EVENTS = new Set([
  'sessions-changed',
  'session-changed',
  'session-renamed',
  'session-window-changed',
  'window-add',
  'window-close',
  'window-renamed',
  'unlinked-window-add',
  'unlinked-window-close',
  'unlinked-window-renamed',
  'layout-change',
  'pane-mode-changed',
  'client-session-changed',
]);

export class ResourceChangeWatcher {
  private cb: WatcherCallbacks;
  private child: ChildProcessWithoutNullStreams | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = 1000;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastFingerprint: string | null = null;
  private stopped = false;
  private mode: 'control' | 'polling' | 'idle' = 'idle';
  private stdoutBuf = '';

  constructor(cb: WatcherCallbacks) {
    this.cb = cb;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.attemptControlMode();
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.debounceTimer = null;
    this.reconnectTimer = null;
    this.pollTimer = null;
    if (this.child && !this.child.killed) {
      try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    this.child = null;
    this.mode = 'idle';
  }

  private log(level: 'info' | 'warn' | 'error', msg: string): void {
    if (this.cb.log) this.cb.log(level, msg);
  }

  /**
   * Schedule a debounced onListChanged() call. Multiple events within the
   * debounce window collapse into a single notification.
   */
  private scheduleNotify(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      try {
        this.cb.onListChanged();
      } catch (e: any) {
        this.log('warn', `onListChanged callback threw: ${e?.message ?? e}`);
      }
    }, 150);
  }

  private async attemptControlMode(): Promise<void> {
    if (this.stopped) return;

    const target = await pickTargetSession();
    if (!target) {
      this.log('info', 'No tmux session available; falling back to polling.');
      this.startPolling();
      return;
    }

    const { socket } = parseTmuxEnv();
    const args: string[] = [];
    if (socket) args.push('-S', socket);
    args.push('-C', 'attach', '-t', target);

    // Strip TMUX from child env so tmux doesn't refuse to nest. We've already
    // pinned the socket via -S when applicable.
    const env = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('tmux', args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      this.log('warn', `Failed to spawn tmux -C: ${e?.message ?? e}. Falling back to polling.`);
      this.startPolling();
      return;
    }

    this.child = child;
    this.mode = 'control';
    this.stdoutBuf = '';

    // Once attached, suppress %output server-side (tmux >= 3.2). On older
    // tmux this is a no-op error message; our parser drops %output anyway.
    try {
      child.stdin.write('refresh-client -F +no-output\n');
    } catch { /* will surface as child exit */ }

    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf8').trim();
      if (s) this.log('warn', `tmux -C stderr: ${s}`);
    });
    child.on('error', (e) => {
      this.log('warn', `tmux -C error: ${e.message}`);
    });
    child.on('exit', (code, signal) => {
      this.child = null;
      if (this.stopped) return;
      this.log('info', `tmux -C exited (code=${code} signal=${signal}); reconnecting in ${this.reconnectDelayMs}ms.`);
      this.scheduleReconnect();
    });

    // Reset backoff after a stable connection (1.5s without exit).
    setTimeout(() => {
      if (!this.stopped && this.child === child) this.reconnectDelayMs = 1000;
    }, 1500);

    this.log('info', `tmux control mode attached to ${target}${socket ? ` (socket=${socket})` : ''}.`);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 5000);
      await this.attemptControlMode();
    }, this.reconnectDelayMs);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl = this.stdoutBuf.indexOf('\n');
    while (nl !== -1) {
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      this.handleLine(line);
      nl = this.stdoutBuf.indexOf('\n');
    }
    // Cap buffer to avoid unbounded growth on malformed streams.
    if (this.stdoutBuf.length > 1024 * 1024) {
      this.stdoutBuf = this.stdoutBuf.slice(-65536);
    }
  }

  private handleLine(line: string): void {
    if (!line.startsWith('%')) return;
    // Notification format: %<name> <args...>
    const space = line.indexOf(' ');
    const name = (space === -1 ? line.slice(1) : line.slice(1, space)).trim();
    if (!name) return;
    // Defensive: explicitly drop high-volume notifications we never use.
    if (name === 'output' || name === 'begin' || name === 'end' || name === 'error') return;
    if (name === 'continue' || name === 'pause') return;
    if (name === 'exit') return; // exit triggers our 'exit' event handler
    if (STRUCTURAL_EVENTS.has(name)) {
      this.scheduleNotify();
    }
    // All other %notifications are intentionally ignored.
  }

  /** Polling fallback. Periodically fingerprint the visible tmux topology. */
  private startPolling(): void {
    if (this.stopped) return;
    this.mode = 'polling';
    // Initial fingerprint without firing.
    this.computeFingerprint().then(fp => { this.lastFingerprint = fp; }).catch(() => { /* ignore */ });
    this.pollTimer = setInterval(async () => {
      if (this.stopped) return;
      try {
        const fp = await this.computeFingerprint();
        if (fp !== this.lastFingerprint) {
          this.lastFingerprint = fp;
          this.scheduleNotify();
        }
      } catch { /* tmux may have stopped; ignore until next tick */ }
    }, 2000);
  }

  /**
   * Lightweight topology fingerprint: one tmux invocation that prints
   * `pane_id:window_id:window_name:session_id:session_name` for every pane.
   * Any structural change (create/close/rename) shows up as a diff.
   */
  private async computeFingerprint(): Promise<string> {
    const fmt = '#{pane_id}:#{window_id}:#{window_name}:#{session_id}:#{session_name}';
    const out = await tmux.executeTmux(['list-panes', '-a', '-F', fmt]);
    // Sort for stable comparison regardless of tmux's iteration order.
    return out.split('\n').sort().join('\n');
  }
}
