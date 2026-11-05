import { isProcessAlive } from './process-alive.js';

/**
 * Notices when the tmux server this process works with is gone.
 *
 * A pane id only means something inside one tmux server instance, so when that
 * instance dies every assignment made on it is void. Gone means: another
 * server now answers on the socket, or nothing answers and its pid no longer
 * runs. Nothing answering while the pid still runs is a hiccup, not a death.
 */
export interface TmuxServerWatchOptions {
  /** `socket:pid:start_time` of the server answering now; throws when none does. */
  fingerprint: () => Promise<string>;
  isAlive?: (pid: number) => boolean;
}

function pidOf(fingerprint: string): number {
  const parts = fingerprint.split(':');
  return Number(parts.at(-2));
}

export class TmuxServerWatch {
  private last: string | null = null;

  constructor(private readonly options: TmuxServerWatchOptions) {}

  /** The server last seen alive, if any. */
  get current(): string | null {
    return this.last;
  }

  /** Remember a server learnt elsewhere, such as the one a grant was made on. */
  saw(fingerprint: string): void {
    this.last = fingerprint;
  }

  /** Look again. Returns the fingerprint of a server that is gone since the last look. */
  async poll(): Promise<string | null> {
    let now: string | null;
    try {
      now = await this.options.fingerprint();
    } catch {
      now = null;
    }
    const before = this.last;
    if (now !== null) {
      this.last = now;
      return before !== null && before !== now ? before : null;
    }
    if (before === null) return null;
    const alive = this.options.isAlive ?? isProcessAlive;
    if (alive(pidOf(before))) return null;
    this.last = null;
    return before;
  }
}
