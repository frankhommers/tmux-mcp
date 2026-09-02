# Test configuration

`.mcp.json` starts this checkout's own build with the control UI switched on,
so you can try human-assigned mode against local changes. JSON has no comments
and not every client accepts JSONC, so `.mcp.json` is strict JSON and the
commentary lives here.

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

## Answering a request: the control UI

`--ui` is on, so the first agent to start also starts a local web daemon (or
reuses a running one). Get its address with:

```bash
cd /Users/frankhommers/Repos/tmux-mcp
node build/index.js ui --print-url --state-dir=test-configs/state
```

Open that URL. Pending requests appear there by themselves — the page holds an
event stream open, so you do not have to refresh to see that something is
waiting. Each request shows the reason the agent gave, a list of assignable
panes with a **Refresh list** button, and **Deny**.

There is no prompt inside Claude Code: MCP elicitation was removed on purpose.
The request URL does show up in the tmux status message and in the MCP log.

Stop the daemon with:

```bash
node build/index.js ui --stop --state-dir=test-configs/state
```

## The thing worth testing

Ask the agent for a pane, then — **after** the request exists — open a brand
new pane, hit **Refresh list**, and assign that one. It is accepted even
though it did not exist when the agent asked. That is the whole reason the UI
exists: a modal prompt can only offer a frozen snapshot.

## Falling back to the shell

The CLI works whether or not the daemon runs, which is also the path over SSH:

```bash
cd /Users/frankhommers/Repos/tmux-mcp
node build/index.js requests --requests-dir=test-configs/requests
node build/index.js grant <request-id> %3 --requests-dir=test-configs/requests
node build/index.js deny  <request-id> "not now" --requests-dir=test-configs/requests
```

(After `npm link` or a global install these are `tmux-mcp requests`, and so
on.) Both paths write the same answer file, and the first answer wins.

## Trying another variant

Edit the `args` array and restart Claude Code:

| Change | What it does |
|---|---|
| drop `--ui` | No web daemon; answer with the CLI or a hook |
| add `--assign-hook=…/examples/assign-hooks/notify-only.sh` | Desktop notification carrying the UI link |
| add `--assign-hook=…/examples/assign-hooks/macos-dialog.sh` | Ask in a macOS dialog |
| add `--scope=window` | Intersect with the static scope: assignments outside the server's own window are refused |

## Your global tmux server also loads

`~/.claude.json` registers a user-scope `tmux` server (the published npx
build). It loads in every directory, including this one, and it is **not**
restricted. Tools are prefixed per server, so check the right one:
`mcp__tmux-human-assigned__list-sessions` returns `[]` before any assignment,
`mcp__tmux__…` returns everything. Disable the global one from `/mcp` for a
clean test.

## What to look for

- Before any assignment, `list-sessions` returns `[]` and `capture-pane` on a
  real pane is denied.
- The request file in `test-configs/requests/` holds the candidate snapshot.
  The agent never receives it — only the pane it was assigned.
- After an assignment, splitting that pane yields another usable pane; every
  other pane stays denied.
- `create-session`, `create-window` and `move-window` are absent from the tool
  list.

State lives in `test-configs/state/` and `test-configs/requests/` rather than
`~/.tmux-mcp`, so a test run never touches your real one. Both are gitignored.
