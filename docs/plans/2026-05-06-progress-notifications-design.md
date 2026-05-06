# Progress notifications for blocking tools

## Problem

Blocking tools (`execute-command-kill-after`, `execute-command-wait-for-exit`, `wait-for-pane-content`, `wait-for-pane-content-gone`, `sleep`) are capped at 59s server-side to stay under the MCP client's typical 60s per-request timeout. Long-running operations are pushed to `execute-command-async` + `get-command-result` polling.

The MCP spec offers a better mechanism: `notifications/progress`. A spec-compliant client with `resetTimeoutOnProgress: true` resets its per-request timer every time it receives a progress notification for the in-flight request. If we emit progress periodically during a blocking wait, the client's timer never expires.

Constraints:
- Notifications only work when the client included a `progressToken` in `request._meta`. Without it, the server has nothing to address notifications to and the client wouldn't reset its timer anyway.
- The current opencode client does not send a `progressToken` (PR anomalyco/opencode#24964 is open to fix this). Other clients vary.
- Periodic keepalives must not defeat the client's "is the server dead?" check.

## Solution

Add a small progress-emitter abstraction that:

1. Detects whether the current request carried a `progressToken`.
2. When absent: emitter is a no-op, the existing 59s cap stays in force. No regression for any client.
3. When present: emitter sends `notifications/progress` from inside the polling loops at most once per 25s. The 59s cap is dropped — `timeoutSeconds` is honored as-is. The client's per-request timer resets on every notification.

Critical anti-hang rule: notifications are only emitted **after a successful tmux poll**. If `tmux capture-pane` (or any underlying tmux call) hangs, the polling iteration never returns, no notification fires, the client times out correctly. This preserves the unresponsiveness signal that the per-request timer exists to provide.

For `sleep` (no tmux interaction): the wait is reshaped into ~1s ticks so the event loop visibly progresses. If the Node event loop is wedged, no ticks, no notifications, client times out.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│ tool handler in index.ts                                 │
│ ┌──────────────────────────────────────────────────┐     │
│ │ const progress = createProgressEmitter(extra,    │     │
│ │                    "<tool-name>");               │     │
│ │ if (!progress.hasToken()) {                      │     │
│ │   if (!checkBlockingTimeout(...)) return error;  │     │
│ │ }                                                │     │
│ │ tmux.runBlocking(..., { progress, ... })         │     │
│ └──────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────┐
│ blocking primitive in tmux.ts                            │
│   poll loop:                                             │
│     await capturePaneContent(...)   ◄── may hang         │
│     progress?.tickIfDue(context)    ◄── only on success  │
│     check completion / pattern / timeout                 │
└──────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────┐
│ ProgressEmitter (src/progress.ts)                        │
│   tickIfDue(): if ≥25s since last emit:                  │
│     extra.sendNotification({                             │
│       method: "notifications/progress",                  │
│       params: { progressToken, progress, message }       │
│     })                                                   │
└──────────────────────────────────────────────────────────┘
```

## Components

### `src/progress.ts` (new)

```ts
export interface ProgressEmitter {
  hasToken(): boolean;
  tickIfDue(context?: string): Promise<void>;
}

export function createProgressEmitter(
  extra: { _meta?: { progressToken?: string | number };
           sendNotification: (n: unknown) => Promise<void> | void },
  toolName: string,
  intervalMs?: number, // default 25000
): ProgressEmitter;
```

Behavior:

- If `extra._meta?.progressToken == null` → returns sentinel: `hasToken() === false`, `tickIfDue()` resolves immediately.
- Otherwise: tracks `startedAt`, `lastEmittedAt`, monotonic `progress` counter. `tickIfDue(context)` fires `notifications/progress` only when `now - lastEmittedAt >= intervalMs`. Always increments `progress` on emit (spec requires monotonic per token).
- Payload: `{ progressToken, progress: <integer counter>, message: "<toolName>: <elapsed>s elapsed[, <context>]" }`. Spec also defines optional `total`, which we omit (we genuinely don't know).

### `src/index.ts` — handler changes

Each blocking tool handler:

1. Adds `extra` as second handler argument (already supplied by SDK).
2. Builds emitter at the top.
3. Skips `checkBlockingTimeout` when `progress.hasToken()`.
4. Passes emitter through opts.

Tools touched:
- `execute-command-kill-after`
- `execute-command-wait-for-exit`
- `wait-for-pane-content`
- `wait-for-pane-content-gone`
- `sleep`

### `src/tmux.ts` — primitive changes

Three exported functions gain `progress?: ProgressEmitter` on their options object:

- `runBlocking(paneId, command, opts)` — call `opts.progress?.tickIfDue(...)` after each `capturePaneContent` in the poll loop.
- `waitForPaneContent(opts)` — same.
- `waitForPaneContentGone(opts)` — same.

`sleep` currently lives in `index.ts` as a single `setTimeout` await. Reshape into a loop of `Math.min(1000, remainingMs)` waits with `progress.tickIfDue()` between iterations.

## Tool description updates

Each affected tool's description gets a clause clarifying:

- The 59s cap applies **only when the client did not send a `progressToken`**.
- When the client sent a token, `timeoutSeconds` is honored as-is and the server emits progress notifications every ~25s during the wait.

## Error handling

- `sendNotification` errors: caught and swallowed by the emitter. A failed notification must never break the actual tool call. Log via `console.error` on first failure only (avoid spam).
- Token absent: silent fast path, no logs.
- Tool-level errors: unchanged from today.

## Testing

Manual verification:

1. Run an MCP client that sets `progressToken` and `resetTimeoutOnProgress: true` (e.g. opencode after #24964 lands, or a small test harness).
2. Invoke `sleep { seconds: 180 }`. Confirm the call returns successfully and the client logs ~7 progress notifications.
3. Confirm `wait-for-pane-content` with a `timeoutSeconds: 300` and a never-matching pattern returns "Timeout after 300s" without the client aborting first.
4. Run a client without `progressToken`. Confirm `sleep { seconds: 120 }` is rejected by the cap check, exactly as today.
5. Simulate a tmux hang (e.g. `kill -STOP` on the tmux server) during a blocking call. Confirm progress notifications stop and the client eventually times out — i.e. the unresponsiveness signal is preserved.

No automated tests added in this iteration — the project has no existing test harness.

## Documentation

README gets a short section: "Long-running tools and progress notifications". Explains:

- Configure `mcp.tmux.timeout` in opencode for the simple per-server bump (already plumbed via opencode #8706).
- When the client sends a `progressToken`, tmux-mcp emits keepalives and the cap is automatically lifted. Required client capability.
- Without a token, the 59s cap remains, use the async tools for longer work.

## Out of scope

- New CLI flags (`--no-progress-notifications`, `--progress-interval-seconds`) — explicitly rejected during brainstorming. Zero-config behavior is the target.
- Server-side wall-clock ceiling — rejected; the "ping only after successful poll" rule is the hang defense.
- Progress notifications for non-blocking tools (`capture-pane`, `execute-command-async`, etc.) — those return in milliseconds, no value.
