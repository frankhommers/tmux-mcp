# Changelog

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
