# Changelog

## Unreleased

### Several agents in one directory

- `--session-id=<value>` / `TMUX_MCP_SESSION_ID` and
  `--session-id-env=<VAR,...>` / `TMUX_MCP_SESSION_ID_ENV` name the agent
  session this server serves; you choose the value or the environment variable
  it comes from.
- Naming `T3CODE_THREAD_ID` in `--session-id-env` opts into a T3 Code
  fallback: an ACP agent lacks that variable until pingdotgg/t3code#30361
  ships, so when it is absent the server asks T3's own per-thread MCP endpoint
  which thread it serves. The token never leaves the machine, and nothing is
  resolved without this configuration.
- Protocol 1.7 sends it to dispatch as the optional `sessionId` in `hello`, so
  agents started from the same directory no longer look the same, and a kept
  pane can be bound to a session rather than a directory. 1.6 peers ignore it.

## 0.3.0 — 2026-09-26

This fork is published through GitHub. Install a fixed release with:

```sh
npx --prefer-online -y github:frankhommers/tmux-mcp#v0.3.0
```

### Optional human-assigned access

- Normal standalone use remains the default. No dispatcher, pairing, or human
  assignment is required unless you enable `--human-assigned` (or its environment
  variable).
- In human-assigned mode, agents request access and humans choose a live pane or
  window. Grants are checked against the configured scope.
- Assign panes through the local CLI, an assign hook, or the optional
  [tmux-dispatch web inbox](https://github.com/frankhommers/tmux-dispatch).
  The CLI and hooks work without a dispatcher.
- The web inbox supports device pairing, revocation, and saved assignment rules.
  tmux-mcp connects outbound; dispatch does not need access to the tmux socket.
- Protocol 1.6 validates saved pane and window IDs against live tmux inventory.
  Confirmed missing targets lose their grants and pin rules. An unavailable
  server is not treated as an empty inventory. Recreating a same-name session
  requires new assignments for its new panes.

See the [README](README.md#optional-human-assigned-access) for configuration and
the [protocol specification](docs/protocol.md) for interoperability details.

Based on [nickgnd/tmux-mcp](https://github.com/nickgnd/tmux-mcp) by Nicolò Gnudi,
with the upstream MIT license retained.
