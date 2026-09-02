# Test configuration

`.mcp.json` starts this checkout's own build, so you can try the
human-assigned mode against local changes. JSON has no comments and not every
client accepts JSONC, so `.mcp.json` is strict JSON and the commentary lives
here.

## Before you start

```bash
npm run build      # .mcp.json runs build/index.js, which is gitignored
```

## Starting it

Claude Code loads `.mcp.json` from the directory you start in, so no flags are
needed:

```bash
cd test-configs
claude
```

On the first start Claude Code asks whether to trust the project's MCP
servers. Until you approve, the server does not load and you will only see
whatever is configured globally.

The paths inside are absolute, so starting from anywhere else works too:

```bash
claude --mcp-config test-configs/.mcp.json
```

## The macOS dialog is switched on

`.mcp.json` runs with `--assign-hook=examples/assign-hooks/macos-dialog.sh`,
so a request pops up a macOS dialog with a text field and Deny/Assign buttons.
It needs a GUI session (not plain SSH) but no Automation or Accessibility
permission — the dialog belongs to `osascript`, which brings itself to the
front.

The dialog lists the panes that existed when the agent asked, but you may type
**any** pane id, including one you open while the dialog is on screen. That is
the point: read the request, open a pane, type its id.

It gives up after 30 minutes. Giving up, closing it, or having no GUI prints
nothing, which simply leaves the request open for `tmux-mcp grant` — you never
lose a request by ignoring the dialog.

To go back to no dialog, drop the `--assign-hook` argument.

## One server on purpose

Only `tmux-human-assigned` is configured. Adding a variant per flag
combination would mean several processes and a few hundred near-identical
tools in context, and any unrestricted entry alongside them would hand the
agent full access anyway — which defeats what you are testing.

To test another variant, edit the `args` array:

| Change this argument | What it changes |
|----------------------|-----------------|
| `--assign-hook=…/tmux-popup.sh` | Ask in a `tmux display-popup` on the attached client (needs tmux >= 3.2) |
| `--assign-hook=…/notify-only.sh` | Desktop notification only; answer with the grant CLI |
| drop `--assign-hook` | No hook: elicitation in the client UI, plus the grant CLI |
| add `--scope=window` | Intersect with the static scope: assignments outside the server's own window are refused |

Restart Claude Code after editing.

## Your global tmux server also loads

`~/.claude.json` registers a user-scope `tmux` server (the published npx
build). It loads in every directory, including this one, and it is **not**
restricted. Two consequences:

- Tools are prefixed per server, so check the right one. `list-sessions` via
  `mcp__tmux-human-assigned__…` returns `[]` before any assignment;
  `mcp__tmux__…` returns everything. Only the first tells you anything about
  human-assigned mode.
- An agent in this session can still reach the unrestricted server. Disable it
  from `/mcp` if you want a clean test.

## Answering a request

Ask the agent to call `request-pane`. Then, from any shell:

```bash
cd /Users/frankhommers/Repos/tmux-mcp
node build/index.js requests --requests-dir=test-configs/requests
node build/index.js grant <request-id> %3 --requests-dir=test-configs/requests
node build/index.js deny  <request-id> "not now" --requests-dir=test-configs/requests
```

(After `npm link` or a global install the same commands are
`tmux-mcp requests`, `tmux-mcp grant …`, `tmux-mcp deny …`.)

When the client supports elicitation, Claude Code also shows the question
directly: a dropdown of the panes that existed when the agent asked, plus an
"other" choice with a free-text field for a pane you opened since. The
channels race and the first answer wins, so you can leave the prompt open and
still grant from the shell.

`requests` lists what is assignable *now*, not what existed when the agent
asked — so the usual flow works: read the request, open a pane, assign that
one.

Requests are written to `test-configs/requests/` instead of
`~/.tmux-mcp/requests`, so a test run never touches your real one and you can
watch the files appear. That directory is gitignored.

## What to look for

- Before any assignment, `list-sessions` returns `[]` and `capture-pane` on a
  real pane is denied. The agent cannot see what it was not given.
- The request file in `test-configs/requests/` holds the candidate snapshot.
  The agent never receives it — only the pane it was assigned.
- Open a brand-new pane after the request and assign that one: it is accepted
  even though it is not in the stored candidate list. A nonexistent id is
  refused and the request stays open.
- After an assignment, splitting that pane yields another usable pane; every
  other pane stays denied.
- `create-session`, `create-window` and `move-window` are absent from the tool
  list.
