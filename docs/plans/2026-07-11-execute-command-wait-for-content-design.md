# Execute command and wait for content

## Problem

Agents sometimes start a short-lived command and then call
`wait-for-pane-content` with `ignoreExisting=true`. The wait tool captures its
baseline only when the second tool call begins. If the command has already
printed the expected content, that content is part of the baseline and is
ignored, causing a false timeout.

The existing tracked command tools avoid this race when waiting for process
exit, but there is no atomic operation for starting a command and returning as
soon as that command produces expected content. This is especially useful for
readiness output from long-running servers.

## Solution

Add `execute-command-wait-for-content`. It starts a tracked command and waits
for plain text or a regular expression in that command's own output. Command
registration, execution, and observation happen in one tool call, eliminating
the ordering race between separate execute and pane-wait calls.

The existing tools retain their focused responsibilities:

- `execute-command-wait-for-exit` waits for a command to finish.
- `execute-command-wait-for-content` waits for output from a command it starts.
- `wait-for-pane-content` observes pane activity not started as a tracked
  command by the same call.

## Tool contract

Parameters:

- `paneId: string` - target pane.
- `command: string` - command to execute.
- `text: string` - plain text or regular expression to match against individual
  output lines. Patterns cannot span lines.
- `regex?: boolean` - interpret `text` as a regular expression. Default:
  `false`.
- `timeoutSeconds: number` - maximum time to wait for a match.
- `pollIntervalMs?: number` - polling interval. Default: 500 ms.
- `suppressHistory?: boolean` - use the existing tracked-command history
  suppression behavior. Default: `true`.

`rawMode` and `noEnter` are not supported because command-specific matching
requires marker-based tracking.

Results:

- `matched` - content was found before the deadline. Return the matched line,
  command ID, current command status, optional exit code, and output captured
  so far. The command may still be running. The MCP result has `isError: false`.
- `exited_without_match` - the command reached a terminal state before the
  deadline without a match. Return its command ID, exit code, and complete
  captured output. The MCP result has `isError: true`.
- `timed_out` - the deadline was reached before a match or exit could be
  accepted. Return the command ID and partial output. The MCP result has
  `isError: true`.

Matching splits captured output into lines; plain text performs a substring
check on each line and regex mode tests each line independently. If a match and
process exit become visible in the same poll before the deadline, `matched`
takes precedence. The result still includes the terminal command status and
exit code so callers can distinguish a successful exit from an error.
Tracked capture joins tmux soft-wrapped rows into logical lines before matching.
Exact trailing spaces at physical line ends are not reliably observable from
tmux's terminal grid, so patterns should not depend on line-end spaces.

## Data flow

1. Validate the regex, pane scope, timeout, and other inputs before starting a
   command.
2. Start the deadline before registering and executing the command through the
   existing marker-based tracking mechanism, so submission time counts toward
   the timeout.
3. Before each poll, return `timed_out` if the deadline has already passed.
4. Poll the pane and extract only content belonging to that command, beginning
   at its start marker.
5. Check the deadline again immediately after capture, before accepting output
   or terminal state newly observed by that capture.
6. Split output into lines and check each line for the requested plain-text
   substring or regex match. If matched, return immediately. Otherwise, check
   whether the end marker appeared and return `exited_without_match` if the
   command finished.
7. Continue until the deadline. On timeout, return without interrupting the
   command.

The polling loop should reuse a shared command-output extraction helper rather
than duplicating marker parsing from `checkCommandStatus`.

## Timeout and progress behavior

The tool follows the existing blocking-tool policy. When the MCP client sends
a progress token, the first notification is emitted after the first successful
poll that leaves the command pending, then approximately every 25 seconds after
successful pending polls. No notification is emitted when tmux polling fails
or hangs. The server-side blocking cap is lifted with a progress token; without
one, the configured cap is enforced so the client cannot abort the request
first.

Timeout is non-destructive. Unlike `execute-command-kill-after`, this tool never
sends Ctrl-C. A capture may reveal a terminal command after the deadline, in
which case the result is still `timed_out` but carries that terminal
`commandStatus` and exit code. Use the returned command ID with
`get-command-result` only while `commandStatus` is `pending`; explicit
intervention also remains available for a pending command.

## Errors

- Invalid regex: return before command execution.
- Excluded or out-of-scope pane: return before command execution.
- tmux capture or command submission failure: return an MCP tool error.
- Command exit without a match: return `exited_without_match`, not a polling
  timeout.

## Known limitation

Matching uses bounded tmux scrollback around the unique command markers, as
existing tracked commands do. An extremely noisy command can push older output
beyond the capture limit before it is observed. Atomic command submission and
observation remove the separate-call baseline ordering race, but do not remove
this scrollback limit. Addressing it would require event-driven `pipe-pane`
capture and is outside this change.

## Testing

The regression case is an immediate command such as `echo READY`; it must
return `matched` even when it exits before the first poll.

Additional coverage:

- A delayed command prints matching content.
- A long-running command prints matching readiness content and remains pending
  when the tool returns.
- A zero-exit command finishes without a match.
- A non-zero-exit command finishes without a match and preserves its exit code.
- Match and terminal exit are observed in the same pre-deadline poll.
- Post-capture deadline checks reject a match or exit first observed after the
  deadline.
- Timeout never interrupts the command and returns a usable command ID; its
  command status may already be terminal.
- Plain-text and regular-expression matching both work.
- Invalid regex prevents command execution.
- Existing execute and pane-wait behavior remains unchanged.
