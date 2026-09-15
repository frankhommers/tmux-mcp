# Agent ↔ dispatch service protocol

The MCP server (on your machine, inside tmux's world) opens a WebSocket to the
dispatch service service and keeps it open while it has a pending pane request. The
service never dials the MCP server, so nothing on your machine listens.

This document is the contract. It is mirrored in the `tmux-dispatch`
repository; there is deliberately no shared package. Both sides declare their
own types and agree at runtime through `PROTOCOL_VERSION`.

## Version

`PROTOCOL_VERSION` is a string `"<major>.<minor>"`, currently **`1.5`**.

- Equal majors connect. A higher minor on either side is fine: unknown
  message types and unknown fields are ignored.
- Different majors refuse. The side that notices logs both versions and says
  which one is behind; the MCP server then falls back to its requests
  directory, so a version mismatch degrades rather than breaks.

Any change to the shape of an existing message is a major bump. Adding a new
message type, or an optional field, is a minor bump.

## Transport

- `wss://<host>/agent` (or `ws://` on loopback).
- The device token goes in the handshake as `Authorization: Bearer <token>`.
- One text frame per message, JSON, with a `type` field.
- The MCP server opens the socket when it has something to say — a request to
  offer, a grant to report, a target to check — and closes it again once that
  is settled and nothing is pending. Idle means no connection.
- On an unclean close while a request is open, the server reconnects with
  backoff (1s, 2s, 4s … capped at 30s) and re-sends its open requests.

## Messages: server → dispatch

### `hello`

First message on every connection. Dispatch answers `welcome` or `refuse`.

```json
{
  "type": "hello",
  "protocolVersion": "1.5",
  "agent": {
    "instanceId": "0f0d8f6c-6a1f-4a3e-9a02-2b0e2f9a1d77",
    "tmuxServer": "/private/tmp/tmux-501/default:16186:1788462695",
    "mcpClient": "opencode",
    "pid": 4711,
    "host": "frank-mbp",
    "cwd": "/Users/frank/Repos/app",
    "tmuxSession": "app",
    "scope": "window",
    "client": "tmux-mcp/0.2.3"
  }
}
```

`instanceId` is stable for the lifetime of one MCP server process. It is how
dispatch tells a reconnect from a new machine. Grants live in that process's
memory, so a new id means the old grants died with the process that held them.

`tmuxServer` is `socket_path:pid:start_time` of the tmux server this agent is
talking to, read afresh on every connection. Pane ids are only unique within
one server instance — a restarted server hands the same numbers out again — so
anything that remembers an id across time has to remember which server it
meant.

`mcpClient` is the name the MCP client gave in its `initialize` handshake,
passed on verbatim. A pid tells a human nothing; the client that runs the
agent, and the pane it runs in (`tmuxSession`), do.

### `request`

A pane request that needs a human.

```json
{
  "type": "request",
  "id": "r-8f3k2a1c",
  "reason": "run the test suite",
  "kind": "pane",
  "createdAt": 1788390336742,
  "expiresAt": 1788392136742,
  "candidates": [
    { "id": "%3", "label": "%3  app:code.1  zsh  \"~/Repos/app\"" }
  ],
  "suggested": "%56"
}
```

`candidates` is a snapshot. It is advisory: the human may answer with any
pane that exists when they answer, and the MCP server validates it then.

`suggested` is an optional target the agent already has in mind, for instance
because a human named it in the task. It is a hint shown next to the request:
it grants nothing, is never matched automatically, and the human remains free
to answer with something else.

### `candidates`

The answer to `refresh`: the same list, recomputed now.

```json
{ "type": "candidates", "id": "r-8f3k2a1c", "candidates": [ … ] }
```

### `withdraw`

The request is no longer answerable.

```json
{ "type": "withdraw", "id": "r-8f3k2a1c", "why": "expired" }
```

`why` is `expired`, `answered_elsewhere` (the CLI got there first), or
`shutdown`.

### `result`

What became of an answer dispatch sent. Sent for every `answer`, so dispatch can
show that an assignment landed — or why it did not.

```json
{ "type": "result", "id": "r-8f3k2a1c", "ok": true, "target": "%3" }
{ "type": "result", "id": "r-8f3k2a1c", "ok": false, "error": "%99 does not exist" }
```

A rejected answer leaves the request open.

### `grants`

Everything this server currently holds, sent after every handshake and again
whenever a grant is added or taken away. It is a full list, not a delta: the
last one received is the truth, so a restarted dispatch relearns the state
from the next report. `reason` is why the pane was asked for; it outlives the
request, which is gone once answered.

```json
{
  "type": "grants",
  "grants": [
    {
      "target": "%3",
      "kind": "pane",
      "label": "%3  main:code.1  zsh",
      "since": 1737000000000,
      "reason": "run the test suite"
    }
  ]
}
```

### `check`

Asked immediately before the server acts on a target it holds. Dispatch
answers `verdict`. If no answer arrives promptly the server proceeds on its
own grant, so a slow or absent dispatch cannot block work.

```json
{ "type": "check", "id": "c-2f1a", "target": "%3" }
```

## Messages: dispatch → server

### `welcome`

```json
{ "type": "welcome", "protocolVersion": "1.5", "account": "frankhommers" }
```

### `refuse`

```json
{ "type": "refuse", "reason": "protocol_version", "protocolVersion": "2.0" }
```

`reason` is `protocol_version` or `unauthorized`. The server does not retry a
refused connection for the life of the request; it falls back to the file
path.

### `answer`

```json
{ "type": "answer", "id": "r-8f3k2a1c", "target": "%3" }
{ "type": "answer", "id": "r-8f3k2a1c", "deny": true, "reason": "not now" }
```

### `refresh`

```json
{ "type": "refresh", "id": "r-8f3k2a1c" }
```

### `revoke`

Take a target back. The server drops the grant and reports what is left.

```json
{ "type": "revoke", "target": "%3" }
```

### `verdict`

The answer to a `check`. `allowed: false` makes the server refuse the action
and drop the grant.

```json
{ "type": "verdict", "id": "c-2f1a", "allowed": true }
```

Dispatch remembers a revocation until the server confirms it is gone, so a
revoke lands even when nothing was connected at the time.

## What dispatch cannot do

Everything tmux-shaped stays on the MCP server. Dispatch can only name a target;
the server checks that it exists right now, sits inside `--scope`, and is not
the server's own pane. A compromised or buggy service can offer a bad answer
and get a `result` with `ok: false`; it cannot widen what an agent may touch.
The same holds in reverse for `revoke` and `verdict`: they can only take
access away, never grant it.
