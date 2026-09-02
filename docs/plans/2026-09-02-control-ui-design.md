# Local control UI (`tmux-mcp ui`)

## Goal

One local web UI, shared by every tmux-mcp server on the machine, where a
human answers pane requests, manages tmux sessions, and peeks at pane
contents. It **replaces** in-client prompting: MCP elicitation is removed
from the server entirely, so there is one place where requests are answered
instead of a prompt whose shape depends on which client the agent runs in.

It exists because prompting inside the agent's client does not fit how a
human actually works: the prompt lists panes that existed when the agent
asked, and the human usually walks over *after* the request and opens the
pane they want to hand over. A page with a live, refreshable list solves
that; a modal snapshot cannot.

## Why one server can serve every MCP instance

The hard part is already built. `~/.tmux-mcp/requests/` is a shared bus:
every human-assigned server writes `<id>.json` there and watches for
`<id>.grant` / `<id>.deny`. Who writes those answers is irrelevant — the
`tmux-mcp grant` CLI does it today. The UI is a second consumer of the same
protocol, so no MCP-to-MCP coordination, IPC, or port negotiation is needed,
and the UI keeps working across agent restarts.

## Non-goals

- MCP elicitation. It is deleted, not made optional: keeping a second asking
  channel is what produced two prompts for one request, and its behaviour
  varies per client (some auto-decline what they cannot render, which would
  silently kill a request). The remaining channels are the UI, the
  `tmux-mcp grant` CLI, and an optional assign hook.
- Typing into panes. The terminal view is read-only (see Terminal view).
  A web page that can `send-keys` is a shell on localhost; that is a
  different security decision and not this one.
- Remote access. Loopback only.
- Replacing the grant CLI. It stays as the headless/SSH path and as the
  fallback when the daemon is not running.
- Attaching a terminal from the browser. A page cannot become a tmux client;
  it can only detach clients and redirect existing ones (see Session
  management).

## Architecture

### Daemon

`tmux-mcp ui` runs one HTTP server bound to `127.0.0.1`.

State lives in `~/.tmux-mcp/ui.json` (mode 0600, dir 0700), beside the
existing `requests/`:

```json
{ "pid": 4711, "port": 7676, "token": "<32 hex>", "startedAt": 1788… , "version": "0.2.3" }
```

Subcommands on the same binary:

```
tmux-mcp ui                 # run in the foreground (what a human types)
tmux-mcp ui --detached      # spawn and return (what the MCP server calls)
tmux-mcp ui --print-url     # print the URL with token, for bookmarking
tmux-mcp ui --stop          # stop a running daemon
```

Port: `--port` (default 7676, `TMUX_MCP_UI_PORT`). If the port is taken by a
daemon of ours (see health), that daemon is used and this one exits 0. If it
is taken by anything else, bind an ephemeral port instead. The chosen port is
always written to `ui.json`, so nothing depends on guessing it.

### Discovery and auto-spawn

The MCP server, when `--ui` is set, ensures a daemon exists at startup:

1. Read `ui.json`. If missing → spawn.
2. If present, check liveness: `process.kill(pid, 0)` **and**
   `GET /api/health` answering `{ ok: true }` within 500 ms. Either failing →
   the file is stale; remove it and spawn.
3. Spawn: `spawn(process.execPath, [<this script>, 'ui', '--detached'], {
   detached: true, stdio: 'ignore' }).unref()`, then wait for `ui.json` to
   appear (up to 3 s).

Two MCP servers starting at once must not both spawn. The spawner takes an
exclusive lock by creating `~/.tmux-mcp/ui.lock` with `wx`; the loser skips
spawning and waits for `ui.json`. A lock older than 30 s is treated as
abandoned and removed.

The daemon outlives the MCP servers. It exits only on `--stop`, SIGTERM, or
SIGINT — never on an idle timer, because a request may arrive hours later.

Failure to start the daemon is never fatal to the MCP server: it logs a
warning and falls back to the other channels.

### Security

- Bound to `127.0.0.1` only.
- Every endpoint except `/api/health` requires the token from `ui.json`,
  sent as `Authorization: Bearer <token>`. The page receives it once via
  `/?t=<token>` and keeps it in `sessionStorage`.
- `Host` must be `127.0.0.1[:port]` or `localhost[:port]`, and `Origin`, when
  present, must match the server's own origin. This blocks DNS rebinding,
  which is the realistic attack on a loopback service.
- The trust boundary equals the requests directory: whoever can read
  `ui.json` can assign panes. Both are 0600 inside a 0700 directory.
- **The UI is not scoped.** It is the human's own tool and shows all of tmux,
  including panes no agent may touch. Assignment, however, stays inside the
  scope recorded in the request (see below).

## Answer channels after removing elicitation

Three ways to answer, none of which lives inside the agent's client:

| Channel | Role |
|---|---|
| The UI | the normal path: see the request, refresh the live list, Assign or Deny |
| `tmux-mcp grant` / `deny` | headless and SSH; also the fallback when the daemon is not running |
| assign hook | optional; mainly to *notify* you, but it may still answer by printing an id |

`src/elicit-channel.ts` and its tests are deleted, and the elicitation wiring
disappears from `src/index.ts`. A client that advertises the elicitation
capability simply never receives a request.

### Being told a request arrived

Nothing interrupts the agent's client any more, so notification has to carry
that weight. On a new request:

- the MCP server keeps its `tmux display-message` on every attached client
  and its MCP log notification, both now including the UI URL for that
  request;
- the assign hook payload gains `uiUrl`, so `notify-only.sh` can put a
  clickable link in the desktop notification;
- the daemon itself notifies: `terminal-notifier` / `notify-send` when
  available, and the browser's Notification API for any open tab, so an
  already-open UI surfaces the request without being watched.

None of these is required for correctness: an unnoticed request simply waits
its 30 minutes, and `tmux-mcp requests` always shows what is pending.

## HTTP API

JSON in, JSON out. Errors are `{ error: string }` with a 4xx/5xx status.

**Discovery**

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | `{ ok, version, pid }`. No auth — used to tell our daemon from a stranger on the port. |

**Requests (milestone 1)**

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/requests` | Pending requests: id, reason, kind, age, and the originating server's pid |
| GET | `/api/requests/:id/targets` | Panes/windows assignable **right now**, filtered by the scope recorded in the request file |
| POST | `/api/requests/:id/grant` | `{ target }` → writes `<id>.grant` |
| POST | `/api/requests/:id/deny` | `{ reason? }` → writes `<id>.deny` |

`targets` is computed live on every call, and the page has a refresh button,
so a pane opened after the request appears without the agent asking again.
The MCP server re-validates the target when it picks up the answer file, so
the UI cannot widen anyone's scope.

**tmux (milestone 2)**

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/tmux` | Tree of sessions → windows → panes, with sizes, titles and current commands |
| GET | `/api/clients` | Attached clients: tty, size, session |
| POST | `/api/clients/:tty/detach` | `detach-client -t <tty>` |
| POST | `/api/clients/:tty/switch` | `{ sessionId }` → `switch-client -c <tty> -t <session>` |
| POST | `/api/sessions` | `{ name }` → new session |
| DELETE | `/api/sessions/:id` | kill session |
| POST | `/api/windows` | `{ sessionId, name? }` → new window |
| PATCH | `/api/windows/:id` | `{ name }` → rename |
| DELETE | `/api/windows/:id` | kill window |
| POST | `/api/panes` | `{ targetPaneId, direction, size? }` → split |
| PATCH | `/api/panes/:id` | `{ title }` → set pane title |
| DELETE | `/api/panes/:id` | kill pane |

**Terminal (milestone 3)**

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/panes/:id/content?lines=N` | `capture-pane -p -e` output, escapes intact |
| GET | `/api/panes/:id/stream` | SSE; emits the capture whenever it changes |

**Events**

| Method | Path | Purpose |
|---|---|---|
| GET | `/events` | SSE: `request-added`, `request-answered`, `request-expired`, `tmux-changed` |

`request-*` events come from watching the requests directory (the same
`startAnswerWatcher` mechanics, plus watching for new `.json` files).
`tmux-changed` comes from the existing `ResourceChangeWatcher` in
`src/control-mode.ts`, reused unchanged, with its polling fallback.

## Pages

- `/` — the app. Two panels: pending requests, and the tmux tree.
- `/r/<id>` — the same app, opened on one request. This is the URL that goes
  into notifications, so any of them lands on the right screen.

A pending request shows the reason verbatim, its age, and the live target
list with a refresh button; each target row has **Assign**, and the request
has **Deny** with an optional reason. Selecting a target shows its terminal
view (milestone 3), so the human can look before deciding.

No framework and no build step: one HTML file, one CSS file, one ES module,
served by the daemon. xterm.js is served from `node_modules`.

## Terminal view

Read-only. The page opens `/api/panes/:id/stream`; the daemon runs
`capture-pane -p -e -t <pane>` about twice a second, hashes the result and
emits only on change, and xterm.js writes it. No PTY, no `send-keys`, no
resize: the pane keeps whatever geometry tmux gave it, and the view sizes
itself to that.

`@xterm/xterm` becomes a regular dependency. It costs roughly a megabyte in
every install, including installs that never start the UI — accepted so the
UI works offline and needs no vendored blob in git.

## Milestones

Each milestone is independently useful and independently shippable.

1. **Inbox** — daemon, discovery/auto-spawn, auth, requests endpoints, SSE,
   the page, removal of elicitation, and the notification paths.
   At the end of this milestone there is exactly one place to answer a
   request, and a pane opened after the request can be assigned there.
2. **Control panel** — the tmux tree and its mutations, clients detach and
   switch.
3. **Terminal view** — `@xterm/xterm`, the content stream, the pane preview.

## Testing

- Daemon: start on an ephemeral port in-process; drive it with `fetch`.
  Auth (missing/wrong token → 401), `Host`/`Origin` rejection, health.
- Discovery: stale `ui.json` (dead pid) is replaced; a live one is reused;
  two concurrent spawners produce one daemon.
- Requests: a request file appears → `/api/requests` lists it → grant writes
  `<id>.grant` → the MCP server picks it up. Reuses the real MCP server over
  stdio, as `test/human-assigned.test.mjs` already does.
- Targets: a pane created after the request shows up in `/targets`; a pane
  outside the request's scope does not.
- tmux endpoints: against a throwaway session, as elsewhere in the suite.
- No elicitation is ever sent, even to a client that advertises the
  capability — asserted against the real server over stdio.
- Notifications: the hook payload carries `uiUrl`; the tmux message contains
  the request URL.

## Files

- `src/ui/daemon.ts` — HTTP server, routing, auth, static files
- `src/ui/state.ts` — `ui.json`, lock, liveness, spawn, stop
- `src/ui/api-requests.ts` — requests, live targets, grant/deny
- `src/ui/api-tmux.ts` — tree, sessions/windows/panes, clients
- `src/ui/events.ts` — SSE hub, requests-dir and control-mode sources
- `src/ui/public/{index.html,app.css,app.js}` — the page
- `src/cli-ui.ts` — the `ui` subcommand
- `src/index.ts` — `--ui` flag, auto-spawn, elicitation wiring removed
- `src/elicit-channel.ts`, `test/elicit-channel.test.mjs` — **deleted**
- `src/assign-hook.ts` — `uiUrl` in the payload
- `package.json` — `@xterm/xterm`
- `README.md`, `test-configs/` — documentation and a config that uses the UI

## Consequence to accept

Without elicitation there is no in-client path at all. Someone who wants
tmux-mcp without a local web server answers with `tmux-mcp grant`, or wires
an assign hook. That is a deliberate trade: one predictable place beats a
prompt whose behaviour depends on the client.
