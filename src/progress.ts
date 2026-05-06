// Progress notifications for blocking tools.
//
// MCP clients that include a `progressToken` in `request._meta` are signaling
// they want out-of-band progress notifications and (per spec) that they will
// reset their per-request timer when one arrives. Emitting one every ~25s
// from inside our blocking-tool poll loops lets long waits run past the
// client's normal request timeout without falsely triggering it.
//
// CRITICAL: notifications must only fire AFTER a successful underlying poll
// (e.g. a successful tmux capture). If our process or its tmux subprocess
// hangs, no notification is emitted, and the client's timeout correctly
// signals unresponsiveness. See docs/plans/2026-05-06-progress-notifications-design.md.

type ProgressToken = string | number;

interface ExtraLike {
  _meta?: { progressToken?: ProgressToken } & Record<string, unknown>;
  sendNotification: (notification: {
    method: 'notifications/progress';
    params: {
      progressToken: ProgressToken;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

export interface ProgressEmitter {
  /** True if the request carried a progressToken. */
  hasToken(): boolean;
  /** Fire a progress notification if at least `intervalMs` has elapsed since
   *  the last one. Call only after a successful poll iteration. */
  tickIfDue(context?: string): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 25_000;

const NOOP: ProgressEmitter = {
  hasToken: () => false,
  tickIfDue: async () => {},
};

export function createProgressEmitter(
  extra: ExtraLike | undefined,
  toolName: string,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): ProgressEmitter {
  const token = extra?._meta?.progressToken;
  if (token === undefined || token === null) return NOOP;

  const startedAt = Date.now();
  let lastEmittedAt = 0;
  let counter = 0;
  let warned = false;

  return {
    hasToken: () => true,
    async tickIfDue(context?: string) {
      const now = Date.now();
      if (now - lastEmittedAt < intervalMs) return;
      lastEmittedAt = now;
      counter += 1;
      const elapsedSec = Math.round((now - startedAt) / 1000);
      const message = context
        ? `${toolName}: ${elapsedSec}s elapsed, ${context}`
        : `${toolName}: ${elapsedSec}s elapsed`;
      try {
        await extra!.sendNotification({
          method: 'notifications/progress',
          params: { progressToken: token, progress: counter, message },
        });
      } catch (err) {
        // A failed notification must never break the tool call. Log once.
        if (!warned) {
          warned = true;
          console.error(`[progress] sendNotification failed for ${toolName}:`, err);
        }
      }
    },
  };
}
