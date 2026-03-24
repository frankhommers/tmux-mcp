# Session Scope for tmux-mcp

## Problem

The MCP server has unrestricted access to every tmux session, window, and pane on the system. Any connected MCP client can read content from, execute commands in, and kill any pane — including those belonging to unrelated sessions.

## Solution

Add opt-in session-level scoping. When enabled, the MCP server can only interact with resources belonging to its own tmux session (plus any sessions it creates). Default behavior is unchanged (no restrictions) for backward compatibility.

## Configuration

```
CLI flag:  --scope=session | --scope=none
Env var:   TMUX_MCP_SCOPE=session | TMUX_MCP_SCOPE=none
```

- CLI flag takes priority over env var.
- Default: `none` (backward compatible, no restrictions).
- When `session`: server detects its own session at startup via `$TMUX` env var.
- If `--scope=session` is set but no session can be detected: hard error at startup. Do not silently fall back to `none`.

## Architecture

### New module: `src/scope.ts`

Responsible for all scope logic:

- **`initScope(scopeValue: string)`** — Called at startup. When `session`, parses `$TMUX` to determine the current session ID. Stores it as the initial allowed session. Throws on failure.
- **`isInScope(id: string, type: 'pane' | 'window' | 'session')`** — Returns `true` if the resource belongs to an allowed session. When `scope=none`, always returns `true`. Uses `tmux display-message -p -t <id> '#{session_id}'` to resolve which session a pane/window belongs to.
- **`assertInScope(id: string, type: 'pane' | 'window' | 'session')`** — Calls `isInScope`; throws an MCP error if out of scope.
- **`addAllowedSession(sessionId: string)`** — Adds a session to the allowed set. Called when `create-session` creates a new session.
- **`getAllowedSessionIds()`** — Returns the set of allowed session IDs (for filtering list operations).

### Filtering on list operations

When `scope=session`:

| Function | Behavior |
|----------|----------|
| `listSessions()` | Returns only allowed sessions |
| `listWindows(sessionId)` | `assertInScope(sessionId, 'session')` before listing |
| `listPanes(windowId)` | `assertInScope(windowId, 'window')` before listing |
| Resource listing (`tmux://pane/{paneId}`) | Only iterates over allowed sessions |

### Guards on mutations

Every tool that accepts a target ID gets an `assertInScope()` call at the start:

| Tool | Check |
|------|-------|
| `capture-pane` | `assertInScope(paneId, 'pane')` |
| `execute-command` | `assertInScope(paneId, 'pane')` |
| `rename-pane` | `assertInScope(paneId, 'pane')` |
| `kill-pane` | `assertInScope(paneId, 'pane')` |
| `split-pane` | `assertInScope(paneId, 'pane')` |
| `capture-last-output` | `assertInScope(paneId, 'pane')` |
| `capture-last-command` | `assertInScope(paneId, 'pane')` |
| `rename-window` | `assertInScope(windowId, 'window')` |
| `kill-window` | `assertInScope(windowId, 'window')` |
| `kill-session` | `assertInScope(sessionId, 'session')` |
| `move-window` | `assertInScope` on both source and destination |
| `create-window` | `assertInScope(sessionId, 'session')` |
| `create-session` | Allowed unconditionally; new session is added to allowed set |

### create-session behavior

`create-session` is always allowed regardless of scope. The newly created session is automatically added to the allowed session set via `addAllowedSession()`. This means the MCP can create sessions and then work within them.

### Error format

When a scope violation occurs, the error message should be clear:

```
Access denied: pane %5 is not in the allowed session scope.
```

## Implementation notes

- Session detection via `$TMUX`: the env var contains `/tmp/tmux-501/default,12345,0` — parse to get the socket path and use `tmux display-message -p '#{session_id}'` to get the session ID at startup.
- `isInScope` for session IDs: direct set membership check (no tmux call needed).
- `isInScope` for window/pane IDs: one `tmux display-message -p -t <id> '#{session_id}'` call, then set membership check.
- Consider caching session lookups for pane/window IDs to avoid repeated tmux calls. Cache should be invalidated when panes are created or destroyed.

## Scope of changes

- New file: `src/scope.ts`
- Modified: `src/index.ts` (CLI flag parsing, initScope call, assertInScope in each tool handler)
- Modified: `src/tmux.ts` (filtering in list functions, addAllowedSession in createSession)
- No changes to existing tool signatures or behavior when `scope=none`.
