# Containerised control UI

## Goal

Run the control UI as a standalone containerised web service that knows
nothing about tmux, and let the MCP server — which already runs on the host,
inside tmux's world — do all the tmux work and hand the UI everything it
needs over a WebSocket it opens itself.

This replaces the shared requests directory as the *primary* transport. That
directory stays as the offline fallback (`tmux-mcp grant`), so nothing is lost
when the container is not running.

## What forced this shape

Measured, not assumed:

```
$ docker run --rm -v /private/tmp/tmux-501:/sock alpine:edge \
    sh -c 'apk add tmux && tmux -S /sock/default list-panes -a'
error connecting to /sock/default (Not supported)
```

The socket is visible inside the container (`srwxrwx--- default`) and the tmux
versions even match exactly (3.7c on the host, 3.7c in `alpine:edge`), but
macOS does not let a Linux container connect through a host unix socket. On a
Linux host it would work; the design must not depend on that.

Second constraint, same family: a container can reach the host only through
`host.docker.internal`, so a host service would have to bind beyond
`127.0.0.1` to be reachable — exposing pane listing and pane assignment to the
local network. Nothing on the host may listen.

Both constraints point the same way: **the host opens the connection, and
carries the tmux knowledge.**

## Architecture

```
  host                                   container
  ┌───────────────────────┐              ┌──────────────────────┐
  │ tmux-mcp (MCP server) │  ws://  ───► │ tmux-mcp-ui          │
  │  · talks to tmux      │              │  · serves the React  │
  │  · owns the scope     │ ◄── answer   │    app to a browser  │
  │  · validates answers  │              │  · holds the inbox   │
  └───────────────────────┘              │  · holds the pool    │
                                          └──────────────────────┘
```

- The MCP server **dials out** to `ws://127.0.0.1:7676/agent` (the container's
  published port). Nothing on the host listens, and the container never
  initiates anything.
- The socket is opened when a request appears and closed when the last
  request of that server is answered. Idle means no connection.
- Everything tmux-shaped — the candidate list, scope, validation, granting —
  stays on the host. The container is a view and a mailbox.

### Messages

Server → UI:

| Message | Payload |
|---|---|
| `hello` | server pid, cwd, tmux session name, scope summary, protocol version |
| `request` | request id, reason, kind, candidates (id + label), createdAt |
| `candidates` | request id, refreshed candidate list (answer to `refresh`) |
| `withdraw` | request id, why (expired, answered elsewhere, server shutting down) |

UI → server (over the same socket):

| Message | Payload |
|---|---|
| `answer` | request id, `{ target }` or `{ deny, reason }` |
| `refresh` | request id — asks for a fresh candidate list |

The server validates every answer exactly as it does today (exists now, inside
`--scope`, not the server's own pane). The UI cannot widen anyone's access; it
can only pick from what it is offered, or name something the server then
checks.

### When the UI is not running

`connect` fails or the socket drops: the server logs it once, writes the
request file as it does today, and the `tmux-mcp requests` / `grant` CLI
answers it. The container is the comfortable path, not a dependency. The
server retries the socket with backoff while the request is open.

## Pre-assigned panes

A pool in the UI, so an agent that asks gets a pane immediately and you find
out afterwards.

An entry is either a **pane id** (`%42`) or a **rule** — a glob over
`session:window.pane` or over the pane title (`dev:*`, `agent-*`). Rules
matter because a pane id you picked yesterday may be gone, while "anything in
session `agents`" keeps working.

On a `request`, the UI matches its pool against the candidates the server just
sent, in the order you listed them, and answers with the first match. It then
marks that entry used, so the same pane is not handed to two agents; an entry
can be marked reusable if you want the opposite.

Nothing is auto-granted that the server would not have accepted anyway: the
match is made against the server's own candidate list, and the answer goes
through the same validation.

The inbox shows what was auto-assigned and to whom, with an undo that revokes
the grant while the pane is still unused. Auto-assignment never fires for a
`kind: window` request unless the entry itself names a window.

The pool is edited from the same page. Panes can be picked from the last
candidate list the UI received, or typed as a rule when no server is
connected — which is the normal case when nothing is pending.

## Deployment

The container runs the same code as `tmux-mcp ui`; it is a packaging choice,
not a second implementation. Someone without Docker keeps running it on the
host and everything works the same way.

```yaml
services:
  tmux-mcp-ui:
    image: ghcr.io/frankhommers/tmux-mcp-ui
    ports: ["127.0.0.1:7676:7676"]
    environment:
      TMUX_MCP_UI_TOKEN: "…"       # shared with the MCP server
    volumes:
      - tmux-mcp-ui:/data          # the pool survives a restart
volumes:
  tmux-mcp-ui:
```

- Published on `127.0.0.1` only, so the port is not on the network.
- `TMUX_MCP_UI_TOKEN` authenticates both the browser and the MCP server's
  WebSocket. Generated and printed on first start when unset.
- The image contains no tmux and mounts nothing from the host.

New MCP server flags:

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--ui-url=<url>` | `TMUX_MCP_UI_URL` | — | Where to dial. Setting it replaces the auto-spawned local daemon. |
| `--ui-token=<token>` | `TMUX_MCP_UI_TOKEN` | — | Sent on connect. |

`--ui` keeps its meaning for the host-local daemon, and is mutually exclusive
with `--ui-url`.

## What this drops

- **The terminal view.** No xterm, no `@xterm/xterm`, no pane-content
  streaming. The container cannot read pane content, and a container that
  could would need everything this design just removed. If you want to look at
  a pane, tmux is one keystroke away.
- **The requests directory as the primary path.** It stays as the fallback and
  as the CLI's contract.

## Security notes

- Nothing on the host listens. The only listening socket is the container's,
  published on loopback.
- The token guards both the browser and the agent socket. A process that can
  reach the port and knows the token can *offer* answers, but every answer is
  validated by the server that asked, against its own scope.
- The pool is the one place where a human decision is made in advance. It is
  stored in the container's volume, and the UI shows every auto-assignment it
  makes, so a pool that is too broad is visible rather than silent.

## Testing

- Protocol: a fake UI (a WebSocket server in the test) drives the MCP server
  through request → candidates → answer, including `refresh` and `withdraw`.
- Fallback: with no UI reachable, a request still lands in the requests dir and
  `tmux-mcp grant` still answers it.
- Reconnect: the UI is stopped mid-request and restarted; the request is
  re-offered and can still be answered.
- Pool: a rule matches and auto-answers; a stale pane id does not match; a used
  entry is not offered twice; a window request is not matched by a pane entry.
- Validation: an answer naming a pane outside the scope is refused and the
  request stays open.
- Container: the image builds, serves the page, and accepts an agent socket.

## Files

- `src/ui/agent-socket.ts` (new) — the server side of the WebSocket: dial,
  backoff, message handling
- `src/ui/protocol.ts` (new) — message types shared by both ends
- `src/index.ts` — `--ui-url`, `--ui-token`, dial on request, fall back to the
  file path
- `ui/` — the container's server gains `/agent` (WebSocket) and the pool
- `ui/src/` — pool editing, auto-assignment feedback in the inbox
- `Dockerfile`, `docker-compose.yml` (new)
- `README.md` — deployment and the two ways to run the UI

## Milestones

1. **Protocol and fallback.** The socket, the message flow, the file fallback,
   the reconnect behaviour. The UI still shows requests as it does now.
2. **Container.** Dockerfile, compose, token handling, the published port,
   documentation.
3. **Pool.** Pre-assigned entries, matching, auto-assignment, undo.
