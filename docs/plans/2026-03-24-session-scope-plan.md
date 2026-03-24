# Session Scope Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add opt-in session-level scoping so the MCP server only interacts with resources in its own session (plus sessions it creates).

**Architecture:** New `src/scope.ts` module handles all scope logic. `src/index.ts` parses the CLI flag/env var and calls `initScope()` at startup, then calls `assertInScope()` in each tool handler. List functions in `src/tmux.ts` filter results when scope is active.

**Tech Stack:** TypeScript, Node.js `parseArgs`, tmux CLI

---

### Task 1: Create `src/scope.ts` module

**Files:**
- Create: `src/scope.ts`

**Step 1: Create the scope module with all exports**

```typescript
import { executeTmux } from "./tmux.js";

type ScopeMode = 'none' | 'session';

let scopeMode: ScopeMode = 'none';
const allowedSessionIds = new Set<string>();

/**
 * Initialize scope. Call once at startup.
 * When mode is 'session', detects the current tmux session from $TMUX env var.
 * Throws if mode is 'session' but no session can be detected.
 */
export async function initScope(mode: string): Promise<void> {
  if (mode !== 'none' && mode !== 'session') {
    throw new Error(`Invalid scope mode: "${mode}". Valid values: none, session`);
  }
  scopeMode = mode as ScopeMode;

  if (scopeMode === 'none') return;

  // $TMUX is set by tmux: "/tmp/tmux-501/default,12345,0"
  const tmuxEnv = process.env.TMUX;
  if (!tmuxEnv) {
    throw new Error(
      'Scope "session" requires running inside tmux, but $TMUX is not set. ' +
      'Either run the MCP server inside a tmux pane, or use --scope=none.'
    );
  }

  try {
    const sessionId = await executeTmux(['display-message', '-p', '#{session_id}']);
    if (!sessionId) {
      throw new Error('Could not determine current tmux session ID.');
    }
    allowedSessionIds.add(sessionId);
  } catch (error: any) {
    throw new Error(`Failed to detect tmux session for scoping: ${error.message}`);
  }
}

/**
 * Returns true if scope is active (not 'none').
 */
export function isScopeActive(): boolean {
  return scopeMode !== 'none';
}

/**
 * Check if a resource is within the allowed scope.
 * When scope is 'none', always returns true.
 */
export async function isInScope(id: string, type: 'pane' | 'window' | 'session'): Promise<boolean> {
  if (scopeMode === 'none') return true;

  try {
    let sessionId: string;
    if (type === 'session') {
      sessionId = id;
    } else {
      // For panes and windows, ask tmux which session they belong to
      sessionId = await executeTmux(['display-message', '-p', '-t', id, '#{session_id}']);
    }
    return allowedSessionIds.has(sessionId);
  } catch {
    // If tmux can't resolve the target, it's not in scope
    return false;
  }
}

/**
 * Assert a resource is in scope. Throws if not.
 */
export async function assertInScope(id: string, type: 'pane' | 'window' | 'session'): Promise<void> {
  if (!(await isInScope(id, type))) {
    throw new Error(`Access denied: ${type} ${id} is not in the allowed session scope.`);
  }
}

/**
 * Add a session to the allowed set. Called after create-session.
 */
export function addAllowedSession(sessionId: string): void {
  allowedSessionIds.add(sessionId);
}

/**
 * Get the set of allowed session IDs. Used by list filtering.
 */
export function getAllowedSessionIds(): ReadonlySet<string> {
  return allowedSessionIds;
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```
git add src/scope.ts
git commit -m "feat: add scope module for session-level access control"
```

---

### Task 2: Parse CLI flag and env var, call `initScope()`

**Files:**
- Modify: `src/index.ts` (lines 1-7 for imports, lines 797-817 for main function)

**Step 1: Add import for scope module**

At `src/index.ts:7`, after the tmux import, add:

```typescript
import { initScope, assertInScope, isScopeActive } from "./scope.js";
```

**Step 2: Add `--scope` to parseArgs and call initScope**

Replace the `main()` function (lines 797-817) with:

```typescript
async function main() {
  try {
    const { values } = parseArgs({
      options: {
        'shell-type': { type: 'string', default: 'bash', short: 's' },
        'scope': { type: 'string' }
      }
    });

    // Set shell configuration
    tmux.setShellConfig({
      type: values['shell-type'] as string
    });

    // Determine scope: CLI flag > env var > default 'none'
    const scopeValue = values['scope'] ?? process.env.TMUX_MCP_SCOPE ?? 'none';
    await initScope(scopeValue);

    // Start the MCP server
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    console.error("Failed to start MCP server:", error);
    process.exit(1);
  }
}
```

**Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```
git add src/index.ts
git commit -m "feat: add --scope CLI flag and TMUX_MCP_SCOPE env var"
```

---

### Task 3: Add `assertInScope` guards to all tool handlers

**Files:**
- Modify: `src/index.ts` (each tool handler that accepts paneId/windowId/sessionId)

Add `await assertInScope(id, type)` as the first line inside each tool's try block. The tools and their checks:

**Pane tools** — add `await assertInScope(paneId, 'pane')`:
- `capture-pane` (line ~172)
- `execute-command` (line ~475)
- `rename-pane` (line ~352)
- `kill-pane` (line ~381)
- `split-pane` (line ~409)
- `capture-last-output` (line ~574)
- `capture-last-command` (line ~603)

**Window tools** — add `await assertInScope(windowId, 'window')`:
- `list-panes` (line ~144): `await assertInScope(windowId, 'window')`
- `rename-window` (line ~323): `await assertInScope(windowId, 'window')`
- `kill-window` (line ~295): `await assertInScope(windowId, 'window')`

**Session tools** — add `await assertInScope(sessionId, 'session')`:
- `list-windows` (line ~116): `await assertInScope(sessionId, 'session')`
- `kill-session` (line ~267): `await assertInScope(sessionId, 'session')`
- `create-window` (line ~229): `await assertInScope(sessionId, 'session')`

**Move-window** — check both source and destination:
```typescript
if (source) await assertInScope(source, 'window');
if (destination) await assertInScope(destination, 'window');
```

**create-session** — no guard, but add session to allowed set after creation:
```typescript
import { addAllowedSession } from "./scope.js";
// ... after session is created:
if (session) addAllowedSession(session.id);
```

**Step 1: Add assertInScope to each pane tool (7 tools)**

For each tool, add `await assertInScope(paneId, 'pane');` as the first line inside the `try` block.

**Step 2: Add assertInScope to each window tool (3 tools)**

For each tool, add the appropriate `await assertInScope(windowId, 'window');`.

**Step 3: Add assertInScope to each session tool (3 tools)**

For each tool, add `await assertInScope(sessionId, 'session');`.

**Step 4: Handle move-window source/destination**

**Step 5: Handle create-session (add to allowed set)**

Add `addAllowedSession` import and call after session creation.

**Step 6: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 7: Commit**

```
git add src/index.ts
git commit -m "feat: add scope guards to all tool handlers"
```

---

### Task 4: Filter list operations when scope is active

**Files:**
- Modify: `src/tmux.ts` (listSessions function)
- Modify: `src/index.ts` (resource listings)

**Step 1: Filter `listSessions` in `src/index.ts`**

In the `list-sessions` tool handler, after calling `tmux.listSessions()`, filter the results:

```typescript
import { isScopeActive, isInScope } from "./scope.js";

// In list-sessions handler:
let sessions = await tmux.listSessions();
if (isScopeActive()) {
  const filtered = [];
  for (const s of sessions) {
    if (await isInScope(s.id, 'session')) filtered.push(s);
  }
  sessions = filtered;
}
```

**Step 2: Filter the sessions resource listing**

In the `server.resource("Tmux Sessions", ...)` handler (line ~632), apply the same filter.

**Step 3: Filter the pane resource listing**

In the `server.resource("Tmux Pane Content", ...)` handler's `list` function (line ~665), filter sessions before iterating.

**Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```
git add src/index.ts
git commit -m "feat: filter list operations by session scope"
```

---

### Task 5: Build, test manually, push

**Step 1: Full build**

Run: `npm run build`
Expected: Clean build, no errors

**Step 2: Verify backward compatibility (scope=none)**

Start server without `--scope` flag. Verify all tools work as before (list-sessions shows all sessions, can access any pane).

**Step 3: Verify session scoping**

Start server with `--scope=session` inside a tmux pane. Verify:
- `list-sessions` shows only the current session
- `list-windows` works for current session
- `capture-pane` works for panes in current session
- `capture-pane` with a pane from another session returns "Access denied" error
- `create-session` works and new session is accessible
- `create-window` works in current session

**Step 4: Commit and push**

```
git add -A
git commit -m "feat: session scope for access control

Add opt-in session-level scoping via --scope=session CLI flag
or TMUX_MCP_SCOPE=session env var. When active, the MCP server
can only interact with panes/windows in its own session plus
any sessions it creates. Default is 'none' (backward compatible)."
git push fork main
```
