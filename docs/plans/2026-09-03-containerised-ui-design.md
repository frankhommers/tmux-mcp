# Containerised control UI

## Goal

Run the control UI as a standalone containerised web service that knows
nothing about tmux, and let the MCP server — which already runs on the host,
inside tmux's world — do all the tmux work and hand the UI everything it
needs over a WebSocket it opens itself.

The service is meant to be reachable publicly, so a request can be answered
from a phone. That works because the connection is outbound: a laptop behind
any router or firewall reaches the service, and nothing on the laptop listens.

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
| `pane-output` | pane id, the pane's current screen including escapes (parked) |
| `withdraw` | request id, why (expired, answered elsewhere, server shutting down) |

UI → server (over the same socket):

| Message | Payload |
|---|---|
| `answer` | request id, `{ target }` or `{ deny, reason }` |
| `refresh` | request id — asks for a fresh candidate list |
| `watch` | pane id, or null to stop — start streaming that pane's screen (parked) |

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

## Two repositories, no shared package

The MCP server and the UI service live in separate repositories:

| Repository | Ships | Holds |
|---|---|---|
| `tmux-mcp` | npm package | the MCP server, the requests-directory fallback, the `grant` CLI, the WebSocket client |
| `tmux-mcp-ui` | container image | the service: agent sockets, sign-in, the inbox, the pool, the React app |

**No shared protocol package.** Each side declares its own message types.
Publishing and versioning a third artifact for six message shapes costs more
than it saves, and the sides are already deployed independently, so the
contract has to hold at runtime anyway.

What enforces it instead:

- `PROTOCOL_VERSION` is a constant on both sides, and `hello` carries it.
  Equal majors connect; different majors refuse, say which side is behind, and
  the server falls back to the requests directory. It never half-speaks a
  protocol it does not know.
- The message shapes are specified in `docs/protocol.md`, kept in this
  repository and mirrored in the UI repository. Changing a message means
  changing that document and the version in the same commit.
- Both sides test against the same recorded fixtures, so drift within a major
  shows up as a failing test rather than a confusing runtime bug.

The honest cost of skipping the package: nothing mechanically prevents the two
type declarations from diverging inside a major version. The fixtures are the
guard, and they are only as good as the cases they cover.

## Authentication

Two audiences — a human in a browser, a machine on a socket — and one account
behind both.

How the human signs in is chosen by what is configured, so a deployment has
one knob fewer:

| Configured | Sign-in | For |
|---|---|---|
| `OIDC_ISSUER` | OIDC, any compliant provider | several people, or an existing identity provider |
| `ADMIN_PASSWORD` | one password prompt | one person, hosted, without running an IdP |
| neither | the token in the URL | localhost |

`AUTH_MODE` overrides the detection when a deployment wants to be explicit.

**The human, in a browser: OIDC.** Discovery plus authorization code with
PKCE, so any compliant provider works — Google, Keycloak, Authentik, Zitadel,
Auth0, Entra — including one you host yourself. No passwords to store and no
mail to send. The account is `issuer` + `sub`, never the email, because an
email can be reassigned. The browser keeps an httpOnly, secure,
`SameSite=Lax` session cookie.

GitHub is deliberately not special-cased: it has no OIDC discovery for user
login (`https://github.com/.well-known/openid-configuration` is a 404; the
only GitHub issuer, `token.actions.githubusercontent.com`, mints tokens for
Actions workloads, not for people). To sign in with GitHub, federate it
behind an OIDC provider.

Who may sign in is the issuer's business, with one optional guard:
`OIDC_ALLOWED_SUBS` limits the service to named subjects, which matters when
the issuer is a public provider rather than your own.

**The human, without a provider: one password.** Set `ADMIN_PASSWORD` and the
service shows a single prompt, then issues the same session cookie. There is
one account; per-account isolation collapses to one, and everything else —
pairing, revocation, the pool — is unchanged.

A single shared secret on a public URL is the weakest of the three, so it does
not stand alone: the comparison is constant-time, failures are rate-limited
per IP and per session with a widening delay, and the service refuses to start
with a password under 12 characters. `ADMIN_PASSWORD_HASH` (argon2id) is
accepted instead, for deployments that would rather not put the secret in the
environment.

**The machine, over the WebSocket: a device token.** Created by pairing, so a
secret is never pasted into a config file by hand:

```
$ tmux-mcp ui-login --url https://tmux.example.com
Open https://tmux.example.com/link and enter: WQ7F-2K9P
Waiting… paired with frankhommers. Token stored in ~/.tmux-mcp/credentials.json
```

A standard device-code flow: the CLI asks for a code, prints it, and polls
while you confirm it in the browser you are already signed into. The token is
opaque and random, stored hashed on the server and `0600` on the host. The
socket presents it as `Authorization: Bearer …` during the handshake.

Every request a device sends belongs to that device's account, and an inbox
only ever shows one account's requests. A device can be revoked from the UI,
which drops its socket immediately.

## Deployment

One image, two auth modes, so the same service runs on a laptop and in public:

| `AUTH_MODE` | Who may connect | For |
|---|---|---|
| `token` | anyone with `TMUX_MCP_UI_TOKEN` | a single user, on `127.0.0.1` |
| `password` | whoever knows `ADMIN_PASSWORD` | one person, hosted |
| `oidc` | accounts from the configured issuer, paired devices | several people, or an existing IdP |

The inbox, the pool and the protocol are the same code in both; only the
adapter that answers "which account is this?" differs.

```yaml
services:
  tmux-mcp-ui:
    image: ghcr.io/frankhommers/tmux-mcp-ui
    environment:
      # Pick one: OIDC_ISSUER for a provider, or ADMIN_PASSWORD for one prompt.
      PUBLIC_URL: https://tmux.example.com
      OIDC_ISSUER: https://id.example.com/application/o/tmux-mcp/
      OIDC_CLIENT_ID: "…"
      OIDC_CLIENT_SECRET: "…"
      OIDC_ALLOWED_SUBS: "…"        # optional allowlist; empty means anyone the issuer admits
      # ADMIN_PASSWORD: "…"         # instead of OIDC_*: a single password prompt
      SESSION_SECRET: "…"
      DATABASE_PATH: /data/tmux-mcp.db
    volumes: [tmux-mcp-ui:/data]
volumes:
  tmux-mcp-ui:
```

TLS is terminated by whatever sits in front (Caddy, Traefik, the platform's
router); the service speaks plain HTTP behind it and requires
`X-Forwarded-Proto: https` when `PUBLIC_URL` is https, so it cannot be run
naked by accident.

State is a single SQLite file: accounts, device tokens (hashed), and pool
entries. Pending requests live in memory — they belong to an open socket and
must not outlive it.

Limits, because the endpoint is public: a cap on pending requests per account,
on devices per account, and a rate limit on the device-code and OAuth
endpoints.

New MCP server flags:

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--ui-url=<url>` | `TMUX_MCP_UI_URL` | — | Where to dial (`wss://…/agent`). Replaces the local daemon. |
| `--ui-token=<token>` | `TMUX_MCP_UI_TOKEN` | from `credentials.json` | Device token, or the shared token in `token` mode. |

`--ui` keeps its meaning for the host-local daemon and is mutually exclusive
with `--ui-url`.

## Watching a pane (parked)

Not being built now, but the protocol leaves room for it and it costs nothing
to keep the door open.

Read-only, and possible precisely because the host holds the connection: the
container never reads pane content, the host sends it.

The UI sends `watch` with a pane id while you are deciding on a request. The
server captures that pane (`capture-pane -p -e`, escapes intact) about twice a
second, hashes the result and sends `pane-output` only when it changed. The UI
writes it into xterm.js. Sending `watch` with `null`, or closing the request,
stops it.

Bounded by design: it only runs while a socket is open, which is only while a
request is pending — exactly when you want to see what a pane is doing before
handing it over. It only covers panes the server already offers as candidates,
so watching cannot see further than assigning could.

Not interactive. Typing would mean the UI can send keystrokes into your panes,
which is a different security decision and not this one.

`@xterm/xterm` is a dependency of `ui/` only, so it never reaches the npm
package or a `npx tmux-mcp` start.

## What this drops

- **The requests directory as the primary path.** It stays as the fallback and
  as the CLI's contract.

## Security notes

- Nothing on the host listens, wherever the service runs. The laptop only
  makes outbound connections.
- Every answer is validated by the server that asked, against its own scope
  and against live tmux state. A compromised service can offer a target; it
  cannot widen what an agent may touch beyond that server's scope, and it
  cannot run anything itself.
- **What a public deployment does see**, deliberately, because choosing a pane
  needs it: session and window names, pane titles, working directories and
  running commands. That is real information about what you are working on,
  sitting on a hosted machine. It is the accepted cost of answering from a
  phone.
- What it can do with a request is bounded but not nothing: assigning a pane
  decides where an agent will work. Hence device tokens rather than a shared
  secret, per-account isolation, and revocation that drops the socket.
- The pool is the one place where a human decision is made in advance. Every
  auto-assignment is shown in the inbox, so a pool that is too broad is
  visible rather than silent.
- Not end-to-end encrypted. The service reads what it relays. Making it blind
  is possible — the host and browser could share a key from pairing — but it
  moves pool matching out of the service and is a project of its own.

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
- Version skew: a `hello` with a different major protocol version is refused
  with a message naming both versions, and the request falls back to the file
  path.
- Auth: an unpaired device is refused; a revoked device's socket drops; one
  account never sees another's requests.
- Pairing: the device-code flow completes, expires, and cannot be replayed.
- OIDC: driven against a stub issuer — discovery, PKCE, state, nonce, a
  tampered id_token rejected, and an account keyed on issuer+sub rather than
  email.
- Password mode: the mode is chosen from the configuration, a wrong password
  is refused in constant time, repeated failures are delayed, and a password
  under 12 characters stops the service from starting.

## Files

In `tmux-mcp`:

- `src/agent-socket.ts` (new) — the WebSocket client: dial, backoff, messages
- `src/protocol.ts` (new) — this side's message types and `PROTOCOL_VERSION`
- `src/index.ts` — `--ui-url`, `--ui-token`, dial on request, fall back to the
  file path
- `docs/protocol.md` (new) — the wire contract
- Removed: `src/ui/`, `src/cli-ui.ts`, `ui/`, `ui-dist/` — the local daemon
  moves to the UI repository, where it becomes the service in `token` mode

In `tmux-mcp-ui`:

- `server/` — agent sockets, browser SSE, auth adapters (`token`, `password`,
  `oidc`), device pairing, SQLite
- `src/` — the React app, plus pool editing and sign-in
- `Dockerfile`, `docker-compose.yml`
- `docs/protocol.md` — the same contract, mirrored

## Milestones

1. **Protocol and fallback.** The socket, the message flow, the file fallback,
   the reconnect behaviour. Runs against the local service in `token` mode, so
   it is useful before anything is hosted.
2. **The service and its image.** One server with pluggable auth, the
   container, `token` mode end to end.
3. **Public deployment.** Password sign-in and OIDC sign-in, device pairing,
   per-account isolation, revocation, rate limits, TLS expectations. Password
   mode lands first: it is what makes a hosted deployment usable without an
   identity provider.
4. **Pool.** Pre-assigned entries, matching, auto-assignment, undo.

Parked: watching a pane.
