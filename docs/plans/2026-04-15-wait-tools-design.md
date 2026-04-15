# Wait tools

## Problem

Agents often need to wait for something to happen in a tmux pane before proceeding. Current blocking tools (`execute-command-kill-after`, `execute-command-wait-for-exit`) only wait for commands *they* started. They can't wait for:

- A long-running process started by another tool (e.g. `execute-command-async` with `rawMode`) to produce specific output.
- A database import to finish (waiting for a prompt or status message).
- A server to become ready (waiting for "Listening on port 3000").
- A process indicator to disappear from the pane.
- A simple delay between operations.

## Solution

Three new tools:

| Tool | Behavior |
|------|----------|
| `wait-for-pane-content` | Polls pane content until a text/regex pattern **appears**. Returns on match or timeout. |
| `wait-for-pane-content-gone` | Polls pane content until a text/regex pattern **disappears**. Returns on match or timeout. |
| `sleep` | Waits a specified number of seconds. No pane interaction. |

## Naming rationale

- `wait-for-pane-content` / `wait-for-pane-content-gone` — makes explicit that the tool checks the **currently visible pane content** via polling, not an event stream. The agent understands it's scanning what's on screen, not subscribing to new output.
- `sleep` — universally understood. Simple delay.

## Tool specifications

### `wait-for-pane-content`

Polls the pane content at regular intervals and waits until a text or regex pattern appears.

Parameters:
- `paneId: string` — target pane. Required.
- `text: string` — text or regex pattern to wait for. Required.
- `regex: boolean` — interpret `text` as a regular expression. Default: `false`.
- `timeoutSeconds: number` — maximum time to wait. Required.
- `pollIntervalMs: number` — how often to check pane content. Default: `500`.
- `lines: string` — number of lines to capture. Default: visible pane height. Passed to `capturePane`.

Returns:
- On match: `{ content: [{ type: "text", text: "Found: <matched text>" }] }` with the matched line(s).
- On timeout: `{ content: [{ type: "text", text: "Timeout after Ns: pattern not found in pane content" }], isError: true }`.

Behavior:
1. Validate the regex pattern if `regex: true`. Return error immediately if invalid.
2. Capture pane content via `capturePane(paneId, lines)`.
3. Search for the pattern (plain `includes()` or `RegExp.test()`).
4. If found, return immediately with the matched content.
5. If not found, sleep `pollIntervalMs` and repeat from step 2.
6. If `timeoutSeconds` elapses without a match, return timeout error.

### `wait-for-pane-content-gone`

Polls the pane content at regular intervals and waits until a text or regex pattern disappears.

Parameters: identical to `wait-for-pane-content`.

Returns:
- On pattern gone: `{ content: [{ type: "text", text: "Pattern no longer found in pane content" }] }`.
- On timeout: `{ content: [{ type: "text", text: "Timeout after Ns: pattern still present in pane content" }], isError: true }`.

Behavior: same polling loop as `wait-for-pane-content`, but the success condition is inverted — the tool returns when the pattern is **not** found in the captured content.

Important caveat documented in the tool description: "Checks the currently visible pane content (controlled by the `lines` parameter), not the full scrollback history. Text that has scrolled out of the capture window is considered 'gone' even if it exists in scrollback."

### `sleep`

Waits for a specified number of seconds. No pane interaction.

Parameters:
- `seconds: number` — time to wait. Required. Must be > 0.

Returns:
- `{ content: [{ type: "text", text: "Slept for Ns" }] }`.

Behavior: `await new Promise(resolve => setTimeout(resolve, seconds * 1000))`.

No scope checks needed — this tool doesn't interact with any pane.

## Implementation notes

### tmux.ts additions

Two new exported functions:

```typescript
async function waitForPaneContent(
  paneId: string,
  pattern: string,
  options: {
    regex?: boolean;
    timeoutSeconds: number;
    pollIntervalMs?: number;
    lines?: string;
  }
): Promise<{ found: true; matchedLine: string } | { found: false }>

async function waitForPaneContentGone(
  paneId: string,
  pattern: string,
  options: {
    regex?: boolean;
    timeoutSeconds: number;
    pollIntervalMs?: number;
    lines?: string;
  }
): Promise<{ gone: true } | { gone: false }>
```

Both use the existing `capturePane()` function and the private `sleep()` utility. The polling loop follows the same pattern as `runBlocking()` — deadline-based with a simple loop.

### index.ts additions

Three new `server.tool()` registrations following the established pattern:
- Scope checks on `wait-for-pane-content` and `wait-for-pane-content-gone` (same as `capture-pane`).
- `sleep` requires no scope checks.
- None of these tools need to be disableable by scope mode (they don't create/destroy resources).

### Regex validation

When `regex: true`, the `text` parameter is passed to `new RegExp(text)` inside a try/catch. Invalid regex returns an immediate error — no polling loop entered.

### Reuse of existing plumbing

- `capturePane(paneId, lines)` — already handles the `tmux capture-pane` call with optional line count.
- `sleep(ms)` — private utility in tmux.ts, already exists.
- Scope checks — `assertInScope()` and `isExcludedPane()` reused as-is.

## Out of scope

- Event-driven text watching via `tmux pipe-pane`. Polling is sufficient for the target use cases (waiting for prompts, status messages, server readiness).
- Scrollback-aware text search. The tools check visible pane content only.
- Combining wait conditions (e.g. "wait for text A OR text B"). The agent can handle this by using regex alternation: `text: "A|B", regex: true`.

## Testing

- `wait-for-pane-content`: start `sleep 2 && echo DONE` in a pane, call `wait-for-pane-content` with `text: "DONE"`, `timeoutSeconds: 5`. Should return after ~2s.
- `wait-for-pane-content` timeout: call with `text: "NEVER"`, `timeoutSeconds: 1`. Should return timeout error after ~1s.
- `wait-for-pane-content` regex: wait for `listening on port \d+` in a pane running a server.
- `wait-for-pane-content-gone`: start a process that prints "Loading...", wait for "Loading" to disappear when it finishes.
- `sleep`: call with `seconds: 1`, verify it returns after ~1s.
- Invalid regex: call with `regex: true`, `text: "[invalid"`. Should return immediate error.
