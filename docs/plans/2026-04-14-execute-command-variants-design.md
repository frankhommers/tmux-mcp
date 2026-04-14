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

Behavior depends on whether GNU `timeout` (or `gtimeout` from macOS coreutils) is available on PATH. Detection runs once at first use and is cached.

**Path A — `timeout` binary available (preferred):**
1. Wrap the user command as `<bin> <N>s <shell> -c '<escaped command>'`. The shell is chosen from `shellConfig.type` (bash/zsh/fish), so the user's command is parsed by a sub-shell of the same family. Single quotes in the command are escaped via `'\''`.
2. Submit the wrapped command with markers (`echo START; <wrapped>; echo DONE_$?`).
3. Poll `checkCommandStatus` every `pollIntervalMs`. Safety deadline = `timeoutSeconds + 10s`.
4. End marker fires either way (timeout's SIGTERM kills the inner command, the outer bash command-list continues to the `echo DONE_$?`):
   - Exit code `124` → kernel killed via SIGTERM → `timed_out_interrupted`.
   - Exit code `137` → SIGKILL fallback → `timed_out_interrupted`.
   - Other → `completed`/`error` with the real exit code.
5. If safety deadline hits without seeing the marker → `timed_out_still_running` (something bypassed timeout; agent should escalate).

**Path B — no `timeout` binary (fallback, manual C-c):**
1. Record `foregroundBefore = #{pane_current_command}` to anchor what "idle" looks like for this pane.
2. Submit command unwrapped (markers only).
3. Poll until end marker or `timeoutSeconds` elapses.
4. On marker → `completed`/`error`.
5. On timeout:
   - If `interruptOnTimeout=false`: return `timed_out`, leave running.
   - Otherwise: send `interruptCount` × `C-c` with `interruptIntervalMs` between, wait `postInterruptWaitMs`. Compare `pane_current_command` after vs before — match means kill succeeded (`timed_out_interrupted`); mismatch means command ignored SIGINT (`timed_out_still_running`).

### Why two paths?

`timeout` is reliable, kernel-level, and yields a real exit code. But it's not in macOS base; coreutils via Homebrew installs it as `gtimeout`. Falling back keeps the tool usable on stock macOS.

### Why the C-c fallback can't read the exit code

Bash's behavior on SIGINT in a `;`-list is version-dependent: sometimes the `echo DONE_$?` runs (giving exit 130), sometimes not. We don't rely on it — `pane_current_command` comparison is the source of truth in the fallback path. Exit code is reported as `null`.

### Known limitations

- **Path A** loses the interactive shell context (aliases, functions defined at the prompt) because the command runs in a fresh sub-shell. Standalone commands work fine.
- **Path B** can't distinguish a same-named nested sub-shell (e.g. user starts `bash` inside `bash`, C-c doesn't kill it). Rare; agent can verify via `capture-pane` or fall back to `kill-pane`.

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
