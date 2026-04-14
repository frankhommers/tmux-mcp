# Execute-command variants

## Problem

`execute-command` has one shape for every use case: fire the command, return a `commandId`, let the agent poll `get-command-result` until completion. That means:

- Agents that *want* to wait must implement polling loops themselves, costing round-trips and tokens.
- There's no built-in way to cap how long a command may run, nor to kill it on timeout. A stuck command (hung network call, runaway loop) sits in the pane until the agent notices and manually sends Ctrl-C.
- The two axes ("do I want to wait?" and "how long may it run?") are conflated into one tool, so the agent has to read docs and remember conventions instead of picking the right tool by name.

## Solution

Replace `execute-command` with three tools, each expressing intent in its name:

| Tool | Behavior |
|------|----------|
| `execute-command-async` | Fire-and-forget. Sends the command, returns `commandId` immediately. Agent polls `get-command-result` if it wants output. Equivalent to today's `execute-command`. |
| `execute-command-kill-after` | Blocks until the command completes OR the timeout elapses. On timeout, sends Ctrl-C sequences to the pane, waits briefly, then returns the partial output and a `timed_out` status. |
| `execute-command-wait-for-exit` | Blocks until the command completes. No timeout. Returns the full output and exit code. |

`rawMode` and `noEnter` remain available only on `execute-command-async`. The blocking variants always use marker-based tracking, because waiting without completion detection is incoherent.

`get-command-result` is kept unchanged — it's the polling companion for `async`.

## Naming rationale

- `async` — the command runs asynchronously from the agent's perspective.
- `kill-after` — makes the destructive consequence of timeout explicit. The agent knows the command will be killed if it takes too long.
- `wait-for-exit` — clear that the tool blocks until the process exits.

## Tool specifications

### `execute-command-async`

Parameters:
- `paneId: string` — target pane.
- `command: string` — command or keystrokes to send.
- `rawMode?: boolean` — send without marker wrapping. Disables tracking.
- `noEnter?: boolean` — send keystrokes without pressing Enter. Implies `rawMode`. Supports special keys (Up, Down, Escape, …) and modifier sequences (C-c, M-a, …).

Returns: `commandId` (or a sent-keys confirmation when `rawMode`/`noEnter`).

Behavior: identical to today's `execute-command`.

### `execute-command-kill-after`

Parameters:
- `paneId: string`
- `command: string`
- `timeoutSeconds: number` — required. How long to wait before killing.
- `pollIntervalMs?: number` — how often to check status. Default: 500.
- `interruptOnTimeout?: boolean` — send Ctrl-C on timeout. Default: `true`.
- `interruptCount?: number` — how many Ctrl-C's to send. Default: 3.
- `interruptIntervalMs?: number` — delay between Ctrl-C's. Default: 200.
- `postInterruptWaitMs?: number` — how long to wait after the last Ctrl-C before capturing final output. Default: 500.

Returns an object containing:
- `status`: `completed` | `error` | `timed_out` | `timed_out_interrupted` | `timed_out_still_running`
- `exitCode`: number or `null` (null when timed out; end marker won't fire because SIGINT aborts the bash command list)
- `output`: string — partial pane content captured at the moment of return.
- `commandId`: string — so the agent can still call `get-command-result` afterwards if it wants.

Behavior:
1. Before sending: record `foregroundBefore = tmux display-message -p -t <paneId> '#{pane_current_command}'`. This anchors what "idle" looks like for this pane (could be `bash`, `zsh`, a nested sub-shell, …).
2. Submit command with markers (same wrapping as `async` without `rawMode`).
3. Poll `checkCommandStatus` every `pollIntervalMs`.
4. If the end marker appears → return with `completed`/`error` and the exit code.
5. If `timeoutSeconds` elapses:
   - If `interruptOnTimeout === false`: return `timed_out`, leave command running. Agent can still use `commandId`.
   - Otherwise: send `interruptCount` × `C-c` via `send-keys -t <paneId> C-c` with `interruptIntervalMs` between them. Wait `postInterruptWaitMs`. Then:
     - Read `foregroundAfter = #{pane_current_command}`.
     - If `foregroundAfter === foregroundBefore` → kill confirmed → `timed_out_interrupted`.
     - Else → command ignored SIGINT → `timed_out_still_running`. Agent can escalate (e.g. `kill-pane`, or send `C-\` via `execute-command-async` with `rawMode`).

### Kill detection — why not the end marker?

A natural idea is to check whether the end-marker echo fired after the C-c. It won't: bash aborts the remaining entries of a `;`-separated command list when it receives SIGINT, so `echo "TMUX_MCP_DONE_…"` never runs. We use `pane_current_command` comparison instead.

### Known limitation

If the user's command launches a same-named sub-shell (e.g. `bash` inside `bash`) and C-c fails to kill it, `foregroundBefore === foregroundAfter` would incorrectly report success. Rare; the agent can always verify via `capture-pane` or fall back to `kill-pane`.

Errors:
- `paneId` out of scope or excluded → scope error (same as other tools).
- `timeoutSeconds` ≤ 0 → validation error.

### `execute-command-wait-for-exit`

Parameters:
- `paneId: string`
- `command: string`
- `pollIntervalMs?: number` — default 500.

Returns the same object shape as `kill-after`, minus `timed_out*` statuses.

Behavior: submit, poll until the end marker appears. No timeout — relies on the agent or the user to interrupt if needed. (If the session or pane disappears, polling will surface that as a standard error.)

## Implementation notes

### New module: `src/execute.ts` (or grouped into `tmux.ts`)

A shared helper `runBlocking(paneId, command, { timeoutMs?, pollIntervalMs, interrupt? })` can back both `kill-after` and `wait-for-exit`:

- Wraps the existing `executeCommand(..., rawMode=false)` + `checkCommandStatus` polling loop.
- Accepts an optional deadline and interrupt config.
- On deadline hit: optionally sends `C-c` sequences via `tmux send-keys -t <pane> C-c`, then does one final `checkCommandStatus` before returning.

The three tool handlers in `src/index.ts` are thin wrappers calling either `tmux.executeCommand` (async) or the new `runBlocking` helper (both blocking variants).

### Tmux send-keys for Ctrl-C

Use `send-keys -t <paneId> C-c` — tmux interprets `C-c` as the key sequence, not the literal string. Already used elsewhere in the codebase for modifier keys.

### Reuse of existing plumbing

- `activeCommands` map, markers, `checkCommandStatus`, marker wrapping with id-suffix — all reused as-is.
- `get-command-result` stays. Blocking tools also write into `activeCommands`, so a commandId returned from `kill-after` or `wait-for-exit` can still be queried after the fact.

## Migration

- Remove `execute-command`. The three new tools replace it cleanly.
- No backwards-compatibility shim (this fork is not a public API; clients are agents whose tool lists are refreshed per session).
- Update `README.md` tool list and examples.

## Out of scope

- A generic `wait-for-command <commandId>` that blocks on an already-submitted async command. The three-variant design removes the need: if you want to block, pick a blocking variant up front.
- `nohup` semantics (surviving shell/pane death). The async tool is agent-fire-and-forget; the command still lives and dies with the pane.
- PR #30 (history pollution prevention via leading space). Tracked separately.

## Testing

- Unit tests for `runBlocking` with a mocked `checkCommandStatus`:
  - Completion before deadline → returns `completed`.
  - Non-zero exit → `error`.
  - Deadline hit, interrupt enabled → sends N × C-c, returns `timed_out_interrupted`.
  - Deadline hit, interrupt disabled → returns `timed_out` without sending keys.
- Integration test against a real tmux session:
  - `sleep 10` with `timeoutSeconds: 1` → `timed_out_interrupted`, `exitCode: null`, `pane_current_command` back to shell.
  - `echo hi` with `timeoutSeconds: 5` → `completed`, exit code 0, output contains `hi`.
  - `sleep 0.2` with `wait-for-exit` → `completed`.
  - SIGINT-ignoring command (e.g. `trap '' INT; sleep 10`) with `timeoutSeconds: 1` → `timed_out_still_running`.
