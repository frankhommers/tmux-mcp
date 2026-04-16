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
| `--shell-type=bash\|zsh\|fish` (`-s`) | — | — | Shell type for the target pane |

#### Scope

By default the MCP server has unrestricted access to all tmux sessions, windows and panes. Use `--scope` to limit what the agent can see and do:

| Mode | Access | Disabled tools |
|------|--------|----------------|
| `none` (default) | Everything | — |
| `session` | Only the session the server runs in | `create-session` |
| `window` | Only the window the server runs in | `create-session`, `create-window`, `kill-window`, `move-window` |

Tools that fall outside the active scope are **removed from the tool list** — the LLM never sees them. Remaining tools that accept an ID (like `capture-pane` or `execute-command-async`) still validate that the target is within the allowed scope at runtime.

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

### Running Label

Tracked commands (`execute-command-async`, `execute-command-kill-after`, `execute-command-wait-for-exit`) display a human-readable label in the pane output before the command executes, surrounded by separator lines for visibility:

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

### Wait-for-pane-content Tools

The `wait-for-pane-content` and `wait-for-pane-content-gone` tools poll the currently visible pane content at regular intervals, waiting for a text string or regex pattern to appear or disappear.

**Parameters:**
- `paneId` (string, required) - Target pane ID (e.g. `%0`)
- `text` (string, required) - The text or regex pattern to match
- `regex` (boolean, optional) - Treat `text` as a regular expression. Defaults to `false`
- `timeoutSeconds` (number, required) - Maximum seconds to wait before giving up
- `pollIntervalMs` (number, optional) - How often to check the pane content in milliseconds
- `lines` (number, optional) - Number of lines to capture from the pane for matching

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

