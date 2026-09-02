# Tmux MCP Server

Model Context Protocol server that enables AI assistants to interact with and view tmux session content. This integration allows AI assistants to read from, control, and observe your terminal sessions.

## Features

- List and search tmux sessions
- View and navigate tmux windows and panes
- Capture and expose terminal content from any pane
- Execute commands in tmux panes and retrieve results (use it at your own risk ⚠️)
- Wait for specific content to appear or disappear in pane output
- Create new tmux sessions and windows
- Split panes horizontally or vertically with customizable sizes
- Kill tmux sessions, windows, and panes

Check out this short video to get excited!

</br>

[![youtube video](http://i.ytimg.com/vi/3W0pqRF1RS0/hqdefault.jpg)](https://www.youtube.com/watch?v=3W0pqRF1RS0)

## Prerequisites

- Node.js
- tmux installed and running

## Usage

### Installation

Run the MCP server via npx:

```sh
npx --prefer-online -y github:frankhommers/tmux-mcp
```

The `--prefer-online` flag tells npx to check for updates instead of using a stale cached version. The `-y` flag skips the install confirmation prompt.

To register it with an MCP client, the exact command depends on the client. For example, with Claude Code:

```sh
claude mcp add tmux -- npx --prefer-online -y github:frankhommers/tmux-mcp
```

For clients that use a JSON configuration file (e.g. Claude Desktop, OpenCode):

```json
{
  "mcpServers": {
    "tmux": {
      "command": "npx",
      "args": ["--prefer-online", "-y", "github:frankhommers/tmux-mcp"]
    }
  }
}
```

> **Note:** Even with `--prefer-online`, npx may sometimes serve a stale cached version. To force a clean fetch, clear the cache and restart the MCP client:
>
> ```sh
> ./scripts/clear-npx-cache.sh
> ```

### Configuration

Append flags after the package name to configure the server:

```sh
npx --prefer-online -y github:frankhommers/tmux-mcp --scope=session --default-split-direction=vertical
```

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--scope=none\|session\|window` | `TMUX_MCP_SCOPE` | `none` | Restrict access to a specific scope (see below) |
| `--include-current-pane` | — | excluded | Allow the agent to interact with its own pane |
| `--default-split-direction=horizontal\|vertical` | `TMUX_MCP_DEFAULT_SPLIT_DIRECTION` | `horizontal` | Default direction for `split-pane` and `new-pane` |
| `--human-assigned` | `TMUX_MCP_HUMAN_ASSIGNED` | off | Start with no access; a human assigns every pane (see below) |
| `--assign-hook=<path>` | `TMUX_MCP_ASSIGN_HOOK` | — | Script that asks the human (see below) |
| `--requests-dir=<path>` | `TMUX_MCP_REQUESTS_DIR` | `~/.tmux-mcp/requests` | Where pending pane requests are stored |
| `--shell-type=bash\|zsh\|fish` (`-s`) | — | — | Shell type for the target pane |

#### Scope

By default the MCP server has unrestricted access to all tmux sessions, windows and panes. Use `--scope` to limit what the agent can see and do:

| Mode | Access | Disabled tools |
|------|--------|----------------|
| `none` (default) | Everything | — |
| `session` | Only the session the server runs in | `create-session` |
| `window` | Only the window the server runs in | `create-session`, `create-window`, `kill-window`, `move-window` |

Tools that fall outside the active scope are **removed from the tool list** — the LLM never sees them. Remaining tools that accept an ID (like `capture-pane` or `execute-command-async`) still validate that the target is within the allowed scope at runtime.

#### Human-assigned access

`--human-assigned` starts the agent with access to **nothing**: no session,
window or pane is visible or usable. The agent asks for one with the
`request-pane` tool, a human assigns it, and only then does it enter scope.
Splitting an assigned pane yields another assigned pane; everything else stays
off limits. It combines with `--scope`: an assignment outside the static scope
is refused. `create-session`, `create-window` and `move-window` are removed
from the tool list.

The agent's request carries a short reason, which the human reads verbatim
before deciding. Every channel offers a list of the panes that existed when
the agent asked, but that list is **advisory**: you may assign any pane or
window that exists at the moment you answer. Opening a fresh pane after
reading the request and handing over that one is the expected workflow. What
is checked at answer time is that the target exists, sits inside `--scope`,
and is not the server's own pane.

A request is answered outside the agent's client — the agent is in none of
these paths, so it cannot answer its own request:

1. **The control UI** — `--ui` starts a local web server, one per machine and
   shared by every tmux-mcp process, at `http://127.0.0.1:7676`. It lists
   pending requests with a **live** target list: a pane you open after reading
   the request is assignable, which a snapshot prompt can never do.

   ```bash
   tmux-mcp ui              # run it yourself
   tmux-mcp ui --print-url  # the URL, including the access token
   tmux-mcp ui --stop
   ```

   The daemon writes `~/.tmux-mcp/ui.json` (pid, port, token, mode 0600). An
   MCP server started with `--ui` reuses a running daemon and otherwise spawns
   one, under a lock so simultaneous agents produce exactly one.

2. **The CLI** — from any shell, including over SSH:

   ```bash
   tmux-mcp requests                  # what is pending, listing panes live
   tmux-mcp grant r-8f3k2 %3          # assign pane %3
   tmux-mcp deny r-8f3k2 "not now"
   ```

3. **An assign hook** — your own script; mainly to notify you, though it may
   answer by printing an id.

There is deliberately **no MCP elicitation**. Prompting inside the agent's
client showed a list frozen at the moment the agent asked, behaved differently
per client, and produced a second prompt whenever a hook was also configured.

The UI binds to `127.0.0.1` only, requires the token from `ui.json`, and
rejects foreign `Host`/`Origin` headers. Whoever can read that file can assign
panes, exactly like whoever can write to the requests directory. The UI itself
is **not** scope-restricted — it is your tool and shows all of tmux — but an
assignment still has to fall inside the scope recorded in the request.

##### Assign hook contract

The hook is spawned once per request. It receives the request as JSON on stdin
(`id`, `reason`, `kind`, `candidates[].id`, `candidates[].label`,
`grantCommand`, and `uiUrl` when the control UI runs) plus
`TMUX_MCP_REQUEST_ID`, `TMUX_MCP_REASON`, `TMUX_MCP_KIND`,
`TMUX_MCP_REQUESTS_DIR` and `TMUX_MCP_UI_URL` in the environment. The
candidates are a snapshot for display; the hook may name any pane that exists
when it answers.

| First line of stdout | Meaning |
|------|---------|
| a pane or window id (`%3`, `@2`) | assign that target; it need not be one of the candidates it was handed |
| `deny` or `deny: <reason>` | refuse; the reason is forwarded to the agent |
| empty, exit 0 | notification only; the answer arrives via the CLI |
| anything else, or exit ≠ 0 | logged and ignored; the request stays pending |

Ready-made examples in [`examples/assign-hooks/`](examples/assign-hooks):
`tmux-popup.sh` (popup inside tmux), `macos-dialog.sh` (GUI dialog),
`notify-only.sh` (desktop notification, answered with the CLI).

> **Scope is only as strong as the agent's other tools.** An agent that can
> also run arbitrary shell commands can call `tmux` directly and bypass this
> server entirely. `--human-assigned` restricts this MCP server, not tmux.
> Anything that can write to the requests directory can assign a pane, so it
> is created `0700`.

## Available Resources

- `tmux://sessions` - List all tmux sessions
- `tmux://pane/{paneId}` - View content of a specific tmux pane
- `tmux://command/{commandId}/result` - Results from executed commands

## Available Tools

- `list-sessions` - List all active tmux sessions
- `find-session` - Find a tmux session by name
- `get-current-session` - Get the tmux session that the MCP server is running in (if any)
- `list-windows` - List windows in a tmux session
- `list-panes` - List panes in a tmux window
- `capture-pane` - Capture content from a tmux pane
- `create-session` - Create a new tmux session
- `create-window` - Create a new window in a tmux session
- `split-pane` - Split a tmux pane horizontally or vertically with optional size
- `kill-session` - Kill a tmux session by ID
- `kill-window` - Kill a tmux window by ID
- `kill-pane` - Kill a tmux pane by ID
- `rename-window` - Rename a tmux window
- `rename-pane` - Rename a tmux pane (set pane title)
- `execute-command-async` - Fire-and-forget: send a command and return a commandId immediately (supports `rawMode`/`noEnter`)
- `execute-command-wait-for-content` - Atomically execute a tracked command and block until its output matches plain text or a regex; returns on command exit observed before the deadline and never interrupts on timeout
- `execute-command-kill-after` - Execute a command and block with a timeout; uses GNU `timeout`/`gtimeout` if available (kernel-level kill, real exit code), otherwise falls back to sending Ctrl-C and verifying via `pane_current_command`
- `execute-command-wait-for-exit` - Execute a command and block until it completes (no timeout)
- `get-command-result` - Get the result of an async command
- `capture-last-output` - Capture the output of a recent command using OSC 133 marks
- `capture-last-command` - Capture the command line of a recent command using OSC 133 marks
- `move-window` - Move a tmux window to a different index or session
- `file-upload` - Upload a file or inline content to a tmux pane (gzip+base64 encoded, works over SSH/docker)
- `file-download` - Download a file from a tmux pane to the local host or return its content
- `wait-for-pane-content` - Wait for text or regex pattern to appear in pane content. Polls the currently visible pane content at regular intervals
- `wait-for-pane-content-gone` - Wait for text or regex pattern to disappear from pane content. Polls the currently visible pane content at regular intervals
- `sleep` - Wait for a specified number of seconds. No pane interaction

### Long-running tools and progress notifications

The blocking tools (`execute-command-kill-after`, `execute-command-wait-for-content`,
`execute-command-wait-for-exit`, `wait-for-pane-content`,
`wait-for-pane-content-gone`, `sleep`) automatically adapt to the MCP client's
progress-notification capability:

- **Client sends a `progressToken`** (per MCP spec): tmux-mcp emits the first
  `notifications/progress` message after the first successful poll that leaves
  the operation pending (or the first successful `sleep` tick), then
  approximately every 25s after successful pending polls or ticks. A
  spec-compliant client with `resetTimeoutOnProgress: true` resets its
  per-request timer on each notification, so long waits run without hitting the
  client's timeout. The server's own 59s cap (configurable via
  `--client-timeout-seconds` / `TMUX_MCP_CLIENT_TIMEOUT_SECONDS`) is
  automatically lifted in this case; the requested `timeoutSeconds` (or
  `seconds`) is honored as-is.

- **Client does not send a token**: the cap is enforced. For longer work, use
  `execute-command-async` and poll with `get-command-result`.

No notification is emitted when tmux polling fails or hangs, so the client's
unresponsiveness check still works.

For per-server timeout configuration in opencode (anomalyco/opencode#8706),
set `mcp.tmux.timeout` in your opencode config to bump the per-server limit
without needing progress-notification support.

### Running Label

Tracked commands (`execute-command-async`, `execute-command-wait-for-content`, `execute-command-kill-after`, `execute-command-wait-for-exit`) display a human-readable label in the pane output before the command executes, surrounded by separator lines for visibility:

```
######################
# Running: npm test
######################
```

When a timeout is configured (`execute-command-kill-after`), the label shows the timeout duration and which mechanism will be used:

```
######################
# Running: npm test
# (timeout: 30s via /usr/bin/timeout)
######################
```

If no `timeout`/`gtimeout` command is available on the target host, the fallback is shown:

```
######################
# Running: npm test
# (timeout: 30s via Ctrl-C)
######################
```

This makes it easy to see at a glance what command is running in each pane, the timeout duration, and how it will be enforced.

### Choosing a Wait Tool

- Use `execute-command-wait-for-exit` when command completion is the condition.
- Use `execute-command-wait-for-content` when output or readiness is the condition.
- Use `wait-for-pane-content` for external or untracked pane activity.

`execute-command-wait-for-content` atomically starts a tracked command and
matches only that command's output. Plain-text substring and regex matching are
both line-by-line, so patterns cannot span lines. Tracked capture joins tmux
soft-wrapped rows into logical lines. Exact trailing spaces at physical line
ends are not reliably observable from tmux's terminal grid, so patterns should
not depend on line-end spaces. Matching is also bounded by captured scrollback;
extremely noisy output can push command content beyond that limit before it is
observed.

**Parameters:**
- `paneId` (string, required) - Target pane ID (e.g. `%0`)
- `command` (string, required) - Command to execute
- `text` (string, required) - Non-empty plain text or regex pattern to match
- `regex` (boolean, optional, default: `false`) - Treat `text` as a regular expression
- `timeoutSeconds` (number, required) - Maximum seconds to wait for a match or command exit
- `pollIntervalMs` (number, optional, default: `500`) - How often to check command output in milliseconds
- `suppressHistory` (boolean, optional, default: `true`) - Prepend a space so supported shells omit the command from history

The deadline starts before command submission, so submission time counts toward
`timeoutSeconds`. After every capture, the deadline is checked before a newly
observed match or exit is accepted. A match takes precedence over an exit seen
in the same capture only when that capture completes before the deadline.

Results use these statuses and MCP error semantics:

- `matched` (`isError: false`) - Matching output was found before the deadline.
  The command may still have
  `commandStatus: pending`; poll the returned `commandId` with
  `get-command-result` for completion and final output.
- `exited_without_match` (`isError: true`) - The command exit was observed
  before the deadline without a match.
- `timed_out` (`isError: true`) - The deadline was reached before a match or
  exit could be accepted. Timeout never interrupts the command. Its returned
  `commandStatus` may already be terminal if that state was captured after the
  deadline; poll the returned `commandId` only when `commandStatus` is
  `pending`.

### Wait-for-pane-content Tools

The `wait-for-pane-content` and `wait-for-pane-content-gone` tools poll the currently visible pane content at regular intervals, waiting for a text string or regex pattern to appear or disappear.

**Parameters:**
- `paneId` (string, required) - Target pane ID (e.g. `%0`)
- `text` (string, required) - The text or regex pattern to match
- `regex` (boolean, optional) - Treat `text` as a regular expression. Defaults to `false`
- `timeoutSeconds` (number, required) - Maximum seconds to wait before giving up
- `pollIntervalMs` (number, optional) - How often to check the pane content in milliseconds
- `lines` (number, optional) - Number of lines to capture from the pane for matching
- `ignoreExisting` (boolean, optional, default: `true`) - Match only content that appears after the wait begins

With `ignoreExisting=true`, content already visible when the tool captures its
baseline is ignored. If output may have appeared before the wait call, set
`ignoreExisting=false`; for commands launched by the same workflow, prefer
`execute-command-wait-for-content` to avoid this ordering race.

### OSC 133 Shell Integration

The `capture-last-output` and `capture-last-command` tools use [OSC 133 semantic prompt marks](https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md) to precisely capture command output without guessing line counts or parsing prompt patterns.

**Requirements:** Your shell must emit OSC 133 escape sequences. Many modern terminals (Ghostty, iTerm2, WezTerm) enable this automatically. For manual setup:

- **Bash (4.4+):** Add to `.bashrc`:
  ```bash
  PS0=$'\033]133;C\007'
  PS1='\[\033]133;B\007\]$ '
  PROMPT_COMMAND='printf "\033]133;D;%s\007" "$?"; printf "\033]133;A\007"'
  ```
- **Zsh:** Add to `.zshrc`:
  ```zsh
  _osc133_preexec() { printf '\e]133;C\e\\' }
  _osc133_precmd() {
    printf '\e]133;D\e\\'
    PROMPT=$'%{\e]133;A\e\\\\%}'"$PROMPT"$'%{\e]133;B\e\\\\%}'
  }
  autoload -Uz add-zsh-hook
  add-zsh-hook preexec _osc133_preexec
  add-zsh-hook precmd _osc133_precmd
  ```
  > **Note:** If you use a prompt theme like [Starship](https://starship.rs/) that regenerates `$PROMPT` in `precmd`, the `_osc133_precmd` hook wraps the regenerated prompt with A/B marks each time — no extra configuration needed.
- **Fish:** Shell integration is built-in for supported terminals.

**Parameters** (both tools):
- `paneId` (string, required) - Target pane ID (e.g. `%0`)
- `n` (number, optional, default: 1) - Which command to capture (1 = most recent, 2 = second most recent, etc.)

**Implementation notes:**

- `capture-last-output` navigates between prompt marks (A/C) directly using `previous-prompt`/`next-prompt` and their `-o` variants.
- `capture-last-command` uses a different strategy: it navigates to the output start (C mark) via `previous-prompt -o`, then moves up one line to the command line and selects the full line. This is necessary because tmux's `next-prompt -o` does not advance from an A mark to the C mark of the same command — tmux treats them as the same prompt region.
- `capture-last-command` only captures **single-line commands**. Multi-line commands will only get the last line.
- The command line includes the PS1 prompt prefix (e.g. `➜` or `$`) since tmux doesn't expose the B mark (where user input starts) for navigation.
