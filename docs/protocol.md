# Agent ↔ dispatch service protocol

The MCP server (on your machine, inside tmux's world) opens a WebSocket to the
dispatch service service and keeps it open while it has a pending pane request. The
service never dials the MCP server, so nothing on your machine listens.

This document is the contract. It is mirrored in the `tmux-dispatch`
repository; there is deliberately no shared package. Both sides declare their
own types and agree at runtime through `PROTOCOL_VERSION`.

## Version

`PROTOCOL_VERSION` is a string `"<major>.<minor>"`, currently **`1.0`**.

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
- The MCP server opens the socket when its first request appears and closes it
  when its last request is answered. Idle means no connection.
- On an unclean close while a request is open, the server reconnects with
  backoff (1s, 2s, 4s … capped at 30s) and re-sends its open requests.

## Messages: server → dispatch

### `hello`

First message on every connection. Dispatch answers `welcome` or `refuse`.

```json
{
  "type": "hello",
  "protocolVersion": "1.0",
  "agent": {
    "pid": 4711,
    "host": "frank-mbp",
    "cwd": "/Users/frank/Repos/app",
    "tmuxSession": "app",
    "scope": "window",
    "client": "tmux-mcp/0.2.3"
  }
}
```

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
  ]
}
```

`candidates` is a snapshot. It is advisory: the human may answer with any
pane that exists when they answer, and the MCP server validates it then.

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

## Messages: dispatch → server

### `welcome`

```json
{ "type": "welcome", "protocolVersion": "1.0", "account": "frankhommers" }
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

## What dispatch cannot do

Everything tmux-shaped stays on the MCP server. Dispatch can only name a target;
the server checks that it exists right now, sits inside `--scope`, and is not
the server's own pane. A compromised or buggy service can offer a bad answer
and get a `result` with `ok: false`; it cannot widen what an agent may touch.
