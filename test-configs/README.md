# Test configuration

`.mcp.json` starts this checkout's own build in human-assigned mode, twice:
`tmux-human-assigned` answers from the CLI only, and `tmux-via-ui` also dials
the control UI. JSON has no comments and not every client accepts JSONC, so
`.mcp.json` is strict JSON and the commentary lives here.

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

## Answering a request in the UI

The UI is its own repository and its own service; this server dials out to it.
Start it once, pair this machine once, and `tmux-via-ui` finds the stored
token by URL from then on:

```bash
cd ../../tmux-mcp-ui
ADMIN_PASSWORD='at-least-twelve' SESSION_SECRET=dev docker compose up -d

node build/index.js ui-login --url http://127.0.0.1:7676
# open http://127.0.0.1:7676/link and enter the code it prints
```

A request from `tmux-via-ui` then appears in the inbox, and granting it there
assigns the pane. `--ui-url` is not a dependency: if the service is down the
request still lands in the requests directory and the CLI still answers it.

## Answering a request from the CLI

Always available, for either server:

```bash
cd /Users/frankhommers/Repos/tmux-mcp
node build/index.js requests --requests-dir=test-configs/requests
node build/index.js grant <request-id> %3 --requests-dir=test-configs/requests
node build/index.js deny  <request-id> "not now" --requests-dir=test-configs/requests
```

(After `npm link` or a global install these are `tmux-mcp requests`, and so
on.) `requests` lists what is assignable *now*, not what existed when the
agent asked.

## Trying another variant

Edit the `args` array and restart Claude Code:

| Change | What it does |
|---|---|
| add `--assign-hook=…/examples/assign-hooks/notify-only.sh` | Desktop notification; answer with the CLI |
| add `--assign-hook=…/examples/assign-hooks/macos-dialog.sh` | Ask in a macOS dialog |
| add `--scope=window` | Intersect with the static scope: assignments outside the server's own window are refused |

## The thing worth testing

Ask the agent for a pane, then — **after** the request exists — open a brand
new pane and assign that one. It is accepted even though it did not exist when
the agent asked, because the target is validated against live tmux state
rather than against the snapshot in the request.

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
- After an assignment, splitting that pane yields another usable pane; every
  other pane stays denied.
- `create-session`, `create-window` and `move-window` are absent from the tool
  list.

Requests are written to `test-configs/requests/`, which is gitignored, so a
test run never touches `~/.tmux-mcp`.
