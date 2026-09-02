# Test configurations

`mcp.json` points at this checkout's own build, so you can try the
human-assigned mode against local changes. JSON has no comments and not every
client accepts JSONC, so `mcp.json` is strict JSON and the commentary lives
here.

## Before you start

```bash
npm run build            # mcp.json runs build/index.js, which is gitignored
```

## Using it with Claude Code

```bash
claude --mcp-config test-configs/mcp.json
```

Or copy it in as the project config, which Claude Code loads automatically:

```bash
cp test-configs/mcp.json .mcp.json
```

All five servers are in one file. Claude Code starts every server it finds, so
delete the entries you are not testing — an agent that can reach
`tmux-unrestricted` is not restricted by the human-assigned entries.

## What each entry is for

| Server | Flags | What it exercises |
|--------|-------|-------------------|
| `tmux-human-assigned` | `--human-assigned` | The default: elicitation when the client supports it, plus the grant CLI. Start here. |
| `tmux-human-assigned-popup` | `+ --assign-hook=examples/assign-hooks/tmux-popup.sh` | A `tmux display-popup` prompt on the attached client. Needs tmux >= 3.2 and an attached client. |
| `tmux-human-assigned-notify` | `+ --assign-hook=examples/assign-hooks/notify-only.sh` | Desktop notification only; you answer with the grant CLI. The headless/SSH story. |
| `tmux-human-assigned-window-scope` | `+ --scope=window` | The intersection rule: assignments outside the server's own window are refused. |
| `tmux-unrestricted` | none | The old behaviour, as a baseline to compare against. |

Every human-assigned entry writes pending requests to
`test-configs/requests/` instead of `~/.tmux-mcp/requests`, so a test run
never touches your real one and you can watch the files appear. The directory
is gitignored.

## Answering a request

Ask the agent to call `request-pane`. Then, from any shell:

```bash
node build/index.js requests --requests-dir=test-configs/requests
node build/index.js grant <request-id> %3 --requests-dir=test-configs/requests
node build/index.js deny  <request-id> "not now" --requests-dir=test-configs/requests
```

(After `npm link` or a global install the same commands are
`tmux-mcp requests`, `tmux-mcp grant …`, `tmux-mcp deny …`.)

The three channels race and the first answer wins, so you can leave an
elicitation prompt open and still grant from the shell.

## What to look for

- Before any grant, `list-sessions` returns `[]` and `capture-pane` on a real
  pane is denied. The agent cannot see what it was not given.
- The request file in `test-configs/requests/` holds the candidate list. The
  agent never receives it — only the pane it was assigned.
- After a grant, splitting that pane yields another usable pane; every other
  pane stays denied.
- `create-session`, `create-window` and `move-window` are absent from the tool
  list in human-assigned mode.
