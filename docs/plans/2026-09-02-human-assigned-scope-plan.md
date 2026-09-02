# Human-Assigned Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `--human-assigned` mode in which the agent starts with access to no tmux pane at all and only gains access to panes/windows a human explicitly assigns, through channels the LLM cannot forge.

**Architecture:** A new `grants` module holds the set of assigned panes/windows and the registry of pending requests. `scope.ts` consults it, so every existing tool is restricted by the same code path that already enforces `--scope`. A new `request-pane` tool builds a candidate list server-side, publishes the request, and races three answer channels — MCP elicitation, a `tmux-mcp grant` CLI, and an optional user-supplied assign hook. First answer wins; unanswered requests stay pending and the agent polls.

**Tech Stack:** TypeScript (ES2022, NodeNext, `strict: true`), `@modelcontextprotocol/sdk` 1.25.2, Node built-ins (`node:fs`, `node:child_process`, `node:util`), tests with `node --test` against the compiled `build/` output.

**Spec:** `docs/plans/2026-09-02-human-assigned-scope-design.md`

## Global Constraints

- All source lives in `src/`, compiles to `build/` via `npm run build` (`tsc`). `strict: true` — no implicit `any`, no unchecked index access assumptions.
- ESM only. Relative imports inside `src/` MUST carry the `.js` extension (e.g. `import { addGrant } from './grants.js'`).
- Tests are `.mjs` files in `test/`, run by `npm test` (which builds first). They import from `../build/*.js`, never from `../src/`.
- Tests that touch real tmux create their own session named `tmux-mcp-<purpose>-${process.pid}-${randomUUID()}` and kill it in a `finally` block. Never touch sessions the test did not create.
- Tool descriptions are strings evaluated at module load. Anything a description embeds (like the human-assigned flag) MUST be resolved by the module-load CLI peek pattern already used for `clientTimeoutSeconds` in `src/index.ts:21-35`, not inside `main()`.
- Never leak un-granted resource ids to the agent. Error messages for out-of-scope targets say only that access is denied.
- Requests directory default `~/.tmux-mcp/requests`, created mode `0700`; request files mode `0600`.
- Request expiry: 30 minutes. Default `request-pane` timeout: 30 seconds (below the 60s client cap, so the tool always returns cleanly and the request lives on server-side).
- Commit after every task with a `feat:`/`test:`/`docs:` prefix. Never add Co-Authored-By or mention any LLM/agent in commit messages.

---

### Task 1: Grants store

Pure in-memory state: which panes/windows are assigned, plus lookup helpers. No tmux calls, no I/O — so it is fully unit-testable.

**Files:**
- Create: `src/grants.ts`
- Test: `test/grants.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type GrantKind = 'pane' | 'window'`
  - `interface GrantRecord { kind: GrantKind; id: string; windowId: string; sessionId: string }`
  - `addGrant(record: GrantRecord): void`
  - `isPaneGranted(paneId: string, windowId: string): boolean`
  - `isWindowGranted(windowId: string): boolean`
  - `isSessionGranted(sessionId: string): boolean`
  - `hasAnyGrant(): boolean`
  - `listGrants(): GrantRecord[]`
  - `pruneGrants(livePaneIds: ReadonlySet<string>, liveWindowIds: ReadonlySet<string>): string[]` — drops records whose resource is gone, returns removed ids
  - `resetGrants(): void` — test helper

- [ ] **Step 1: Write the failing test**

Create `test/grants.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addGrant,
  isPaneGranted,
  isWindowGranted,
  isSessionGranted,
  hasAnyGrant,
  listGrants,
  pruneGrants,
  resetGrants,
} from '../build/grants.js';

test('starts empty: nothing is granted', () => {
  resetGrants();
  assert.equal(hasAnyGrant(), false);
  assert.equal(isPaneGranted('%1', '@1'), false);
  assert.equal(isWindowGranted('@1'), false);
  assert.equal(isSessionGranted('$0'), false);
  assert.deepEqual(listGrants(), []);
});

test('a granted pane is allowed, its neighbours are not', () => {
  resetGrants();
  addGrant({ kind: 'pane', id: '%3', windowId: '@1', sessionId: '$0' });
  assert.equal(isPaneGranted('%3', '@1'), true);
  assert.equal(isPaneGranted('%4', '@1'), false);
  // A pane grant does not imply access to the whole window.
  assert.equal(isWindowGranted('@1'), false);
  // The session is visible so list-sessions can show the path to the pane.
  assert.equal(isSessionGranted('$0'), true);
  assert.equal(isSessionGranted('$1'), false);
  assert.equal(hasAnyGrant(), true);
});

test('a granted window covers every pane inside it', () => {
  resetGrants();
  addGrant({ kind: 'window', id: '@2', windowId: '@2', sessionId: '$0' });
  assert.equal(isWindowGranted('@2'), true);
  assert.equal(isPaneGranted('%9', '@2'), true);
  assert.equal(isPaneGranted('%9', '@3'), false);
});

test('adding the same grant twice does not duplicate it', () => {
  resetGrants();
  addGrant({ kind: 'pane', id: '%3', windowId: '@1', sessionId: '$0' });
  addGrant({ kind: 'pane', id: '%3', windowId: '@1', sessionId: '$0' });
  assert.equal(listGrants().length, 1);
});

test('pruneGrants drops resources that no longer exist', () => {
  resetGrants();
  addGrant({ kind: 'pane', id: '%3', windowId: '@1', sessionId: '$0' });
  addGrant({ kind: 'pane', id: '%4', windowId: '@1', sessionId: '$0' });
  addGrant({ kind: 'window', id: '@2', windowId: '@2', sessionId: '$0' });

  const removed = pruneGrants(new Set(['%3']), new Set(['@1']));

  assert.deepEqual(removed.sort(), ['%4', '@2']);
  assert.equal(isPaneGranted('%3', '@1'), true);
  assert.equal(isPaneGranted('%4', '@1'), false);
  assert.equal(isWindowGranted('@2'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/grants.test.mjs`
Expected: FAIL — `Cannot find module '../build/grants.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/grants.ts`:

```typescript
/**
 * Human-assigned grants.
 *
 * In --human-assigned mode the agent starts with access to nothing. Every
 * pane or window it may touch was handed to it by a human, and lands here.
 * This module is pure state: no tmux calls, no I/O.
 */

export type GrantKind = 'pane' | 'window';

export interface GrantRecord {
  kind: GrantKind;
  /** Pane id (%3) for kind 'pane', window id (@2) for kind 'window'. */
  id: string;
  /** Window the resource lives in (equals `id` for kind 'window'). */
  windowId: string;
  sessionId: string;
}

const grants = new Map<string, GrantRecord>();

export function addGrant(record: GrantRecord): void {
  grants.set(record.id, record);
}

export function isPaneGranted(paneId: string, windowId: string): boolean {
  if (grants.get(paneId)?.kind === 'pane') return true;
  return isWindowGranted(windowId);
}

export function isWindowGranted(windowId: string): boolean {
  return grants.get(windowId)?.kind === 'window';
}

export function isSessionGranted(sessionId: string): boolean {
  for (const record of grants.values()) {
    if (record.sessionId === sessionId) return true;
  }
  return false;
}

export function hasAnyGrant(): boolean {
  return grants.size > 0;
}

export function listGrants(): GrantRecord[] {
  return [...grants.values()];
}

/**
 * Drop grants whose resource has disappeared (pane closed, window killed).
 * Returns the ids that were removed.
 */
export function pruneGrants(
  livePaneIds: ReadonlySet<string>,
  liveWindowIds: ReadonlySet<string>
): string[] {
  const removed: string[] = [];
  for (const [id, record] of grants) {
    const alive = record.kind === 'pane' ? livePaneIds.has(id) : liveWindowIds.has(id);
    if (!alive) {
      grants.delete(id);
      removed.push(id);
    }
  }
  return removed;
}

/** Test helper: forget every grant. */
export function resetGrants(): void {
  grants.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/grants.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/grants.ts test/grants.test.mjs
git commit -m "feat: add grants store for human-assigned scope"
```

---

### Task 2: Scope integration and the `--human-assigned` flag

Human-assigned **intersects** with the static scope: a resource must pass the existing `--scope` check *and* be granted.

**Files:**
- Modify: `src/scope.ts` (add flag state; consult grants inside `isInScope`)
- Modify: `src/index.ts:1564-1571` (parse the flag in `main()`), `src/index.ts:21-35` (module-load peek)
- Test: `test/grants.test.mjs` (extend)

**Interfaces:**
- Consumes: `isPaneGranted`, `isWindowGranted`, `isSessionGranted` from Task 1.
- Produces:
  - `initHumanAssigned(enabled: boolean): void` in `src/scope.ts`
  - `isHumanAssigned(): boolean` in `src/scope.ts`
  - `humanAssigned: boolean` module-level const in `src/index.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/grants.test.mjs`:

```javascript
import { initScope, initHumanAssigned, isHumanAssigned, isInScope } from '../build/scope.js';

test('human-assigned denies everything until something is granted', async () => {
  resetGrants();
  initScope('none');
  initHumanAssigned(true);
  assert.equal(isHumanAssigned(), true);
  // No tmux call needed: a window id short-circuits on the grant check.
  assert.equal(await isInScope('@1', 'window'), false);
  assert.equal(await isInScope('$0', 'session'), false);
});

test('human-assigned allows a granted window and its session', async () => {
  resetGrants();
  initScope('none');
  initHumanAssigned(true);
  addGrant({ kind: 'window', id: '@2', windowId: '@2', sessionId: '$0' });
  assert.equal(await isInScope('@2', 'window'), true);
  assert.equal(await isInScope('@3', 'window'), false);
  assert.equal(await isInScope('$0', 'session'), true);
  assert.equal(await isInScope('$1', 'session'), false);
  initHumanAssigned(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/grants.test.mjs`
Expected: FAIL — `initHumanAssigned is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/scope.ts`, add the import at the top:

```typescript
import { isPaneGranted, isWindowGranted, isSessionGranted } from "./grants.js";
```

Add module state next to `let excludeSelf = true;`:

```typescript
// Human-assigned mode: the allowed set starts empty and only grows through
// explicit human assignment (see grants.ts). It intersects with the static
// scope above — a resource must pass both checks.
let humanAssigned = false;

export function initHumanAssigned(enabled: boolean): void {
  humanAssigned = enabled;
}

export function isHumanAssigned(): boolean {
  return humanAssigned;
}
```

Rename the existing `isInScope` body to a private `isInStaticScope` and add the combined check. Replace the whole exported `isInScope` function with:

```typescript
export async function isInScope(id: string, type: 'pane' | 'window' | 'session'): Promise<boolean> {
  if (!(await isInStaticScope(id, type))) return false;
  if (!humanAssigned) return true;
  return isInGrantedScope(id, type);
}

async function isInGrantedScope(id: string, type: 'pane' | 'window' | 'session'): Promise<boolean> {
  try {
    if (type === 'session') return isSessionGranted(id);
    if (type === 'window') return isWindowGranted(id);
    // A pane is allowed by its own grant or by a grant on its window. Only
    // resolve the window when the cheap check did not already succeed.
    if (isPaneGranted(id, '')) return true;
    const windowId = await executeTmux(['display-message', '-p', '-t', id, '#{window_id}']);
    return isPaneGranted(id, windowId);
  } catch {
    return false;
  }
}
```

(`isPaneGranted(id, '')` is safe: an empty window id can never match a granted window.)

Rename the original function declaration from `export async function isInScope(` to `async function isInStaticScope(` — keep its body untouched, including the `if (scopeMode === 'none') return true;` early return.

In `src/index.ts`, next to the `clientTimeoutSeconds` peek (after line 37), add:

```typescript
// Human-assigned mode. Peeked at module load (like clientTimeoutSeconds)
// because tool registration and tool descriptions depend on it.
const humanAssigned: boolean = (() => {
  const argv = process.argv.slice(2);
  if (argv.includes('--human-assigned')) return true;
  const env = process.env.TMUX_MCP_HUMAN_ASSIGNED;
  return env === '1' || env === 'true';
})();
```

In `main()`, extend the `parseArgs` options with:

```typescript
        'human-assigned': { type: 'boolean', default: false },
        'assign-hook': { type: 'string' },
        'requests-dir': { type: 'string' },
```

and after `initExcludeSelf(...)` add:

```typescript
    initHumanAssigned(humanAssigned);
```

Extend the `scope.js` import on line 8 with `initHumanAssigned` and `isHumanAssigned`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/grants.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/scope.ts src/index.ts test/grants.test.mjs
git commit -m "feat: intersect scope with human-assigned grants"
```

---

### Task 3: Candidate listing

One tmux call inventories every pane, so `request-pane` can show the human a readable list. Tab-separated to avoid the `:`-splitting bug that affects pane titles in the existing helpers.

**Files:**
- Modify: `src/tmux.ts` (add `listAllPanes`, `listAllWindowIds`)
- Test: `test/human-assigned.test.mjs` (new file, first test)

**Interfaces:**
- Consumes: `executeTmux` from `src/tmux.ts`.
- Produces:
  - `interface TmuxPaneInventory { paneId: string; windowId: string; sessionId: string; sessionName: string; windowName: string; paneIndex: string; currentCommand: string; title: string }`
  - `listAllPanes(): Promise<TmuxPaneInventory[]>`
  - `listAllWindowIds(): Promise<string[]>`

- [ ] **Step 1: Write the failing test**

Create `test/human-assigned.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { executeTmux, listAllPanes, listAllWindowIds } from '../build/tmux.js';

test('listAllPanes reports ids, names and current command', async () => {
  const sessionName = `tmux-mcp-inventory-${process.pid}-${randomUUID()}`;
  await executeTmux(['new-session', '-d', '-s', sessionName]);
  try {
    const panes = await listAllPanes();
    const mine = panes.filter(p => p.sessionName === sessionName);
    assert.equal(mine.length, 1);
    assert.match(mine[0].paneId, /^%\d+$/);
    assert.match(mine[0].windowId, /^@\d+$/);
    assert.match(mine[0].sessionId, /^\$\d+$/);
    assert.equal(mine[0].paneIndex, '0');
    assert.ok(mine[0].currentCommand.length > 0);

    const windowIds = await listAllWindowIds();
    assert.ok(windowIds.includes(mine[0].windowId));
  } finally {
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/human-assigned.test.mjs`
Expected: FAIL — `listAllPanes is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/tmux.ts`:

```typescript
export interface TmuxPaneInventory {
  paneId: string;
  windowId: string;
  sessionId: string;
  sessionName: string;
  windowName: string;
  paneIndex: string;
  currentCommand: string;
  title: string;
}

/**
 * Inventory every pane on the tmux server in one call.
 *
 * Fields are tab-separated: pane titles and window names may contain ':',
 * which would break the ':'-separated formats used by the older helpers.
 */
export async function listAllPanes(): Promise<TmuxPaneInventory[]> {
  const format = [
    '#{pane_id}', '#{window_id}', '#{session_id}', '#{session_name}',
    '#{window_name}', '#{pane_index}', '#{pane_current_command}', '#{pane_title}',
  ].join('\t');
  const output = await executeTmux(['list-panes', '-a', '-F', format]);
  if (!output) return [];
  return output.split('\n').flatMap(line => {
    const f = line.split('\t');
    if (f.length < 8) return [];
    return [{
      paneId: f[0],
      windowId: f[1],
      sessionId: f[2],
      sessionName: f[3],
      windowName: f[4],
      paneIndex: f[5],
      currentCommand: f[6],
      title: f[7],
    }];
  });
}

/** Every window id on the tmux server. Used to prune stale grants. */
export async function listAllWindowIds(): Promise<string[]> {
  const output = await executeTmux(['list-windows', '-a', '-F', '#{window_id}']);
  if (!output) return [];
  return output.split('\n').filter(Boolean);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/human-assigned.test.mjs`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add src/tmux.ts test/human-assigned.test.mjs
git commit -m "feat: add whole-server pane inventory helper"
```

---

### Task 4: Request registry and candidate builder

The heart of `request-pane`: create a request, hold it until answered, and build the candidate list the human chooses from.

**Files:**
- Create: `src/requests.ts`
- Test: `test/requests.test.mjs`

**Interfaces:**
- Consumes: `listAllPanes` (Task 3), `getScopeMode`/`isInScope`/`getSelfPaneId`/`isExcludedPane` from `src/scope.ts`, `isPaneGranted`/`isWindowGranted` (Task 1).
- Produces:
  - `interface Candidate { id: string; label: string; windowId: string; sessionId: string }`
  - `type Answer = { status: 'granted'; target: string; via: string } | { status: 'denied'; reason?: string; via: string }`
  - `interface PaneRequest { id: string; reason: string; kind: GrantKind; candidates: Candidate[]; createdAt: number }`
  - `buildCandidates(kind: GrantKind): Promise<Candidate[]>`
  - `createRequest(reason: string, kind: GrantKind, candidates: Candidate[]): PaneRequest`
  - `getRequest(id: string): PaneRequest | undefined`
  - `answerRequest(id: string, answer: Answer): boolean` — false when unknown/already answered/invalid target
  - `waitForAnswer(id: string, timeoutMs: number): Promise<Answer | null>`
  - `onRequestSettled(listener: (id: string, answer: Answer) => void): void`
  - `expireRequests(maxAgeMs: number): string[]`
  - `resetRequests(): void`

- [ ] **Step 1: Write the failing test**

Create `test/requests.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRequest,
  getRequest,
  answerRequest,
  waitForAnswer,
  expireRequests,
  resetRequests,
} from '../build/requests.js';

const CANDIDATES = [
  { id: '%3', label: '%3  main:code.1  zsh  "logs"', windowId: '@1', sessionId: '$0' },
  { id: '%5', label: '%5  main:code.2  node  "server"', windowId: '@1', sessionId: '$0' },
];

test('a request is pending until answered', async () => {
  resetRequests();
  const req = createRequest('run the tests', 'pane', CANDIDATES);
  assert.match(req.id, /^r-[a-z0-9]+$/);
  assert.equal(getRequest(req.id)?.reason, 'run the tests');

  const answered = answerRequest(req.id, { status: 'granted', target: '%3', via: 'grant' });
  assert.equal(answered, true);

  const answer = await waitForAnswer(req.id, 1000);
  assert.deepEqual(answer, { status: 'granted', target: '%3', via: 'grant' });
});

test('waitForAnswer resolves when the answer arrives later', async () => {
  resetRequests();
  const req = createRequest('run the tests', 'pane', CANDIDATES);
  setTimeout(() => answerRequest(req.id, { status: 'granted', target: '%5', via: 'hook' }), 50);
  const answer = await waitForAnswer(req.id, 2000);
  assert.deepEqual(answer, { status: 'granted', target: '%5', via: 'hook' });
});

test('waitForAnswer returns null on timeout and the request stays pending', async () => {
  resetRequests();
  const req = createRequest('run the tests', 'pane', CANDIDATES);
  assert.equal(await waitForAnswer(req.id, 50), null);
  assert.ok(getRequest(req.id));
  assert.equal(answerRequest(req.id, { status: 'granted', target: '%3', via: 'grant' }), true);
});

test('a target outside the candidate list is refused and the request survives', async () => {
  resetRequests();
  const req = createRequest('run the tests', 'pane', CANDIDATES);
  assert.equal(answerRequest(req.id, { status: 'granted', target: '%99', via: 'grant' }), false);
  assert.ok(getRequest(req.id));
});

test('answering twice is refused', async () => {
  resetRequests();
  const req = createRequest('run the tests', 'pane', CANDIDATES);
  assert.equal(answerRequest(req.id, { status: 'denied', via: 'grant' }), true);
  assert.equal(answerRequest(req.id, { status: 'granted', target: '%3', via: 'hook' }), false);
});

test('expireRequests removes old requests', async () => {
  resetRequests();
  const req = createRequest('run the tests', 'pane', CANDIDATES);
  assert.deepEqual(expireRequests(60_000), []);
  const expired = expireRequests(-1);
  assert.deepEqual(expired, [req.id]);
  assert.equal(getRequest(req.id), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/requests.test.mjs`
Expected: FAIL — `Cannot find module '../build/requests.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/requests.ts`:

```typescript
import { randomBytes } from 'node:crypto';
import type { GrantKind } from './grants.js';
import { isPaneGranted, isWindowGranted } from './grants.js';
import { listAllPanes } from './tmux.js';
import { isInScope, getSelfPaneId, isExcludedPane } from './scope.js';

export interface Candidate {
  id: string;
  /** Human-readable one-liner shown in prompts. */
  label: string;
  windowId: string;
  sessionId: string;
}

export type Answer =
  | { status: 'granted'; target: string; via: string }
  | { status: 'denied'; reason?: string; via: string };

export interface PaneRequest {
  id: string;
  reason: string;
  kind: GrantKind;
  candidates: Candidate[];
  createdAt: number;
}

interface PendingEntry {
  request: PaneRequest;
  answer: Answer | null;
  waiters: Array<(answer: Answer) => void>;
}

const pending = new Map<string, PendingEntry>();
const settledListeners: Array<(id: string, answer: Answer) => void> = [];

/**
 * Build the list of resources a human may pick from: everything inside the
 * static scope, minus the server's own pane and anything already granted.
 * The agent never sees this list — only the item it was given.
 */
export async function buildCandidates(kind: GrantKind): Promise<Candidate[]> {
  const panes = await listAllPanes();
  const selfPane = getSelfPaneId();
  const candidates: Candidate[] = [];
  const seenWindows = new Set<string>();

  for (const pane of panes) {
    if (pane.paneId === selfPane && isExcludedPane(pane.paneId)) continue;
    // isInScope() also consults grants; check the static scope by asking about
    // a resource we know is ungranted is not possible, so filter grants here.
    if (kind === 'pane') {
      if (isPaneGranted(pane.paneId, pane.windowId)) continue;
      if (!(await isInStaticScopeForCandidate(pane.paneId, pane.windowId, pane.sessionId))) continue;
      candidates.push({
        id: pane.paneId,
        label: `${pane.paneId}  ${pane.sessionName}:${pane.windowName}.${pane.paneIndex}  ${pane.currentCommand}  "${pane.title}"`,
        windowId: pane.windowId,
        sessionId: pane.sessionId,
      });
    } else {
      if (seenWindows.has(pane.windowId)) continue;
      seenWindows.add(pane.windowId);
      if (isWindowGranted(pane.windowId)) continue;
      if (!(await isInStaticScopeForCandidate(pane.paneId, pane.windowId, pane.sessionId))) continue;
      candidates.push({
        id: pane.windowId,
        label: `${pane.windowId}  ${pane.sessionName}:${pane.windowName}`,
        windowId: pane.windowId,
        sessionId: pane.sessionId,
      });
    }
  }
  return candidates;
}

/**
 * Static-scope check for a candidate. isInScope() would also apply the grant
 * filter (which is exactly what we are trying to bypass here), so we check
 * the enclosing window/session instead, which grants never widen.
 */
async function isInStaticScopeForCandidate(
  paneId: string,
  windowId: string,
  sessionId: string
): Promise<boolean> {
  // Temporarily reason about the static scope only: a candidate is eligible
  // when its session (scope=session) or window (scope=window) matches.
  const { getScopeMode, getAllowedSessionIds, getAllowedWindowId } = await import('./scope.js');
  const mode = getScopeMode();
  if (mode === 'none') return true;
  if (mode === 'session') return getAllowedSessionIds().has(sessionId);
  return getAllowedWindowId() === windowId;
}

export function createRequest(reason: string, kind: GrantKind, candidates: Candidate[]): PaneRequest {
  const request: PaneRequest = {
    id: `r-${randomBytes(4).toString('hex')}`,
    reason,
    kind,
    candidates,
    createdAt: Date.now(),
  };
  pending.set(request.id, { request, answer: null, waiters: [] });
  return request;
}

export function getRequest(id: string): PaneRequest | undefined {
  return pending.get(id)?.request;
}

/**
 * Record an answer. Returns false when the request is unknown, already
 * answered, or the target is not one of the offered candidates — the request
 * then stays pending so another channel (or a corrected grant) can answer it.
 */
export function answerRequest(id: string, answer: Answer): boolean {
  const entry = pending.get(id);
  if (!entry || entry.answer) return false;
  if (answer.status === 'granted' && !entry.request.candidates.some(c => c.id === answer.target)) {
    return false;
  }
  entry.answer = answer;
  for (const waiter of entry.waiters) waiter(answer);
  entry.waiters.length = 0;
  for (const listener of settledListeners) {
    try { listener(id, answer); } catch { /* listener errors are not fatal */ }
  }
  pending.delete(id);
  return true;
}

/** Resolves with the answer, or null when the timeout elapses first. */
export function waitForAnswer(id: string, timeoutMs: number): Promise<Answer | null> {
  const entry = pending.get(id);
  if (!entry) return Promise.resolve(null);
  if (entry.answer) return Promise.resolve(entry.answer);
  return new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(null);
    }, timeoutMs);
    entry.waiters.push(answer => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(answer);
    });
  });
}

/** Called whenever a request is answered, by any channel. */
export function onRequestSettled(listener: (id: string, answer: Answer) => void): void {
  settledListeners.push(listener);
}

/** Drop requests older than maxAgeMs. Returns the ids removed. */
export function expireRequests(maxAgeMs: number): string[] {
  const now = Date.now();
  const expired: string[] = [];
  for (const [id, entry] of pending) {
    if (now - entry.request.createdAt > maxAgeMs) {
      pending.delete(id);
      expired.push(id);
    }
  }
  return expired;
}

export function listPendingRequests(): PaneRequest[] {
  return [...pending.values()].map(e => e.request);
}

/** Test helper. */
export function resetRequests(): void {
  pending.clear();
  settledListeners.length = 0;
}
```

Add the missing accessor to `src/scope.ts` (next to `getAllowedSessionIds`):

```typescript
/** The window id the static scope is anchored on, or null. */
export function getAllowedWindowId(): string | null {
  return allowedWindowId;
}
```

Replace the dynamic `await import('./scope.js')` in `isInStaticScopeForCandidate` with a top-level import once written — the import list at the top of `src/requests.ts` becomes:

```typescript
import { isInScope, getSelfPaneId, isExcludedPane, getScopeMode, getAllowedSessionIds, getAllowedWindowId } from './scope.js';
```

and the function body drops its first line. Remove `isInScope` from the import if it ends up unused.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/requests.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/requests.ts src/scope.ts test/requests.test.mjs
git commit -m "feat: add pane-request registry and candidate builder"
```

---

### Task 5: Requests directory and the grant channel

Requests are mirrored to disk so a human in any shell can answer them. The server watches for answer files.

**Files:**
- Create: `src/requests-dir.ts`
- Test: `test/requests-dir.test.mjs`

**Interfaces:**
- Consumes: `PaneRequest`, `Answer` (Task 4).
- Produces:
  - `resolveRequestsDir(cliValue?: string): string`
  - `writeRequestFile(dir: string, request: PaneRequest): Promise<void>`
  - `removeRequestFiles(dir: string, id: string): Promise<void>`
  - `readRequestFile(dir: string, id: string): Promise<PaneRequest | null>`
  - `listRequestFiles(dir: string): Promise<PaneRequest[]>`
  - `writeAnswerFile(dir: string, id: string, answer: 'grant' | 'deny', body: string): Promise<void>`
  - `startAnswerWatcher(dir: string, onAnswer: (id: string, answer: Answer) => void): () => void`

- [ ] **Step 1: Write the failing test**

Create `test/requests-dir.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  writeRequestFile,
  readRequestFile,
  listRequestFiles,
  removeRequestFiles,
  writeAnswerFile,
  startAnswerWatcher,
} from '../build/requests-dir.js';

const REQUEST = {
  id: 'r-abc123',
  reason: 'run the tests',
  kind: 'pane',
  createdAt: Date.now(),
  candidates: [{ id: '%3', label: '%3  main:code.1  zsh  ""', windowId: '@1', sessionId: '$0' }],
};

test('a request round-trips through the requests dir with 0600 mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmux-mcp-req-'));
  await writeRequestFile(dir, REQUEST);

  const read = await readRequestFile(dir, REQUEST.id);
  assert.equal(read.reason, 'run the tests');
  assert.equal(read.candidates[0].id, '%3');

  const mode = (await stat(join(dir, `${REQUEST.id}.json`))).mode & 0o777;
  assert.equal(mode, 0o600);

  const all = await listRequestFiles(dir);
  assert.equal(all.length, 1);

  await removeRequestFiles(dir, REQUEST.id);
  assert.deepEqual(await readdir(dir), []);
});

test('the watcher reports a grant answer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmux-mcp-req-'));
  await writeRequestFile(dir, REQUEST);

  const seen = [];
  const stop = startAnswerWatcher(dir, (id, answer) => seen.push([id, answer]));
  try {
    await writeAnswerFile(dir, REQUEST.id, 'grant', '%3');
    await waitUntil(() => seen.length > 0, 3000);
  } finally {
    stop();
  }

  assert.equal(seen[0][0], REQUEST.id);
  assert.deepEqual(seen[0][1], { status: 'granted', target: '%3', via: 'grant' });
});

test('the watcher reports a deny answer with its reason', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmux-mcp-req-'));
  await writeRequestFile(dir, REQUEST);

  const seen = [];
  const stop = startAnswerWatcher(dir, (id, answer) => seen.push([id, answer]));
  try {
    await writeAnswerFile(dir, REQUEST.id, 'deny', 'not now');
    await waitUntil(() => seen.length > 0, 3000);
  } finally {
    stop();
  }

  assert.deepEqual(seen[0][1], { status: 'denied', reason: 'not now', via: 'grant' });
});

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('condition not met within timeout');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/requests-dir.test.mjs`
Expected: FAIL — `Cannot find module '../build/requests-dir.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/requests-dir.ts`:

```typescript
import { watch } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Answer, PaneRequest } from './requests.js';

const POLL_INTERVAL_MS = 1000;

export function resolveRequestsDir(cliValue?: string): string {
  return cliValue
    ?? process.env.TMUX_MCP_REQUESTS_DIR
    ?? join(homedir(), '.tmux-mcp', 'requests');
}

export async function ensureRequestsDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function writeRequestFile(dir: string, request: PaneRequest): Promise<void> {
  await ensureRequestsDir(dir);
  await writeFile(join(dir, `${request.id}.json`), JSON.stringify(request, null, 2), { mode: 0o600 });
}

export async function readRequestFile(dir: string, id: string): Promise<PaneRequest | null> {
  try {
    return JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8')) as PaneRequest;
  } catch {
    return null;
  }
}

export async function listRequestFiles(dir: string): Promise<PaneRequest[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const requests: PaneRequest[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const request = await readRequestFile(dir, entry.slice(0, -'.json'.length));
    if (request) requests.push(request);
  }
  return requests;
}

export async function removeRequestFiles(dir: string, id: string): Promise<void> {
  for (const suffix of ['.json', '.grant', '.deny']) {
    await rm(join(dir, `${id}${suffix}`), { force: true });
  }
}

/** Written by the `tmux-mcp grant` / `tmux-mcp deny` CLI. */
export async function writeAnswerFile(
  dir: string,
  id: string,
  answer: 'grant' | 'deny',
  body: string
): Promise<void> {
  await ensureRequestsDir(dir);
  await writeFile(join(dir, `${id}.${answer}`), body, { mode: 0o600 });
}

/**
 * Watch the requests dir for answer files. fs.watch is used when available
 * and backed by a poll, because fs.watch is unreliable on some filesystems.
 * Returns a stop function.
 */
export function startAnswerWatcher(
  dir: string,
  onAnswer: (id: string, answer: Answer) => void
): () => void {
  const handled = new Set<string>();

  const scan = async (): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const isGrant = entry.endsWith('.grant');
      const isDeny = entry.endsWith('.deny');
      if (!isGrant && !isDeny) continue;
      if (handled.has(entry)) continue;
      handled.add(entry);
      let body = '';
      try {
        body = (await readFile(join(dir, entry), 'utf8')).trim();
      } catch {
        handled.delete(entry);
        continue;
      }
      const id = entry.slice(0, entry.lastIndexOf('.'));
      if (isGrant) {
        onAnswer(id, { status: 'granted', target: body, via: 'grant' });
      } else {
        onAnswer(id, { status: 'denied', reason: body || undefined, via: 'grant' });
      }
    }
  };

  void ensureRequestsDir(dir).then(() => { void scan(); });

  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(dir, () => { void scan(); });
  } catch {
    watcher = null;
  }
  const timer = setInterval(() => { void scan(); }, POLL_INTERVAL_MS);
  timer.unref?.();

  return () => {
    clearInterval(timer);
    try { watcher?.close(); } catch { /* already closed */ }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/requests-dir.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/requests-dir.ts test/requests-dir.test.mjs
git commit -m "feat: persist pane requests and watch for grant answers"
```

---

### Task 6: `tmux-mcp requests | grant | deny` CLI

The channel that works everywhere, including headless and over SSH.

**Files:**
- Create: `src/cli-grant.ts`
- Modify: `src/index.ts` (dispatch subcommands at the top of `main()`)
- Test: `test/grant-cli.test.mjs`

**Interfaces:**
- Consumes: `resolveRequestsDir`, `listRequestFiles`, `readRequestFile`, `writeAnswerFile` (Task 5).
- Produces: `runGrantCli(argv: string[]): Promise<number>` — returns the process exit code.

- [ ] **Step 1: Write the failing test**

Create `test/grant-cli.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);

const REQUEST = {
  id: 'r-abc123',
  reason: 'run the tests',
  kind: 'pane',
  createdAt: Date.now(),
  candidates: [
    { id: '%3', label: '%3  main:code.1  zsh  "logs"', windowId: '@1', sessionId: '$0' },
  ],
};

async function withRequestsDir() {
  const dir = await mkdtemp(join(tmpdir(), 'tmux-mcp-cli-'));
  await writeFile(join(dir, `${REQUEST.id}.json`), JSON.stringify(REQUEST), { mode: 0o600 });
  return dir;
}

function cli(dir, args) {
  return run(process.execPath, ['build/index.js', ...args, `--requests-dir=${dir}`], { cwd: process.cwd() });
}

test('requests lists the pending request with its reason', async () => {
  const dir = await withRequestsDir();
  const { stdout } = await cli(dir, ['requests']);
  assert.match(stdout, /r-abc123/);
  assert.match(stdout, /run the tests/);
  assert.match(stdout, /%3/);
});

test('grant writes an answer file for a valid candidate', async () => {
  const dir = await withRequestsDir();
  const { stdout } = await cli(dir, ['grant', 'r-abc123', '%3']);
  assert.match(stdout, /Granted/);
  assert.equal((await readFile(join(dir, 'r-abc123.grant'), 'utf8')).trim(), '%3');
});

test('grant refuses a target that is not a candidate', async () => {
  const dir = await withRequestsDir();
  await assert.rejects(
    () => cli(dir, ['grant', 'r-abc123', '%99']),
    err => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /not one of the candidates/i);
      return true;
    }
  );
});

test('deny writes a deny file with the reason', async () => {
  const dir = await withRequestsDir();
  await cli(dir, ['deny', 'r-abc123', 'not now']);
  assert.equal((await readFile(join(dir, 'r-abc123.deny'), 'utf8')).trim(), 'not now');
});

test('grant on an unknown request fails cleanly', async () => {
  const dir = await withRequestsDir();
  await assert.rejects(
    () => cli(dir, ['grant', 'r-nope', '%3']),
    err => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /no pending request/i);
      return true;
    }
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/grant-cli.test.mjs`
Expected: FAIL — the server starts instead of the CLI and the calls hang or error.

- [ ] **Step 3: Write minimal implementation**

Create `src/cli-grant.ts`:

```typescript
import { parseArgs } from 'node:util';
import {
  listRequestFiles,
  readRequestFile,
  resolveRequestsDir,
  writeAnswerFile,
} from './requests-dir.js';

export const GRANT_CLI_COMMANDS = ['requests', 'grant', 'deny'] as const;
export type GrantCliCommand = (typeof GRANT_CLI_COMMANDS)[number];

export function isGrantCliCommand(value: string | undefined): value is GrantCliCommand {
  return value !== undefined && (GRANT_CLI_COMMANDS as readonly string[]).includes(value);
}

/**
 * `tmux-mcp requests|grant|deny` — the channel a human can use from any
 * shell, including over SSH where no dialog or popup is available.
 */
export async function runGrantCli(argv: string[]): Promise<number> {
  const command = argv[0] as GrantCliCommand;
  const rest = argv.slice(1);
  const { values, positionals } = parseArgs({
    args: rest,
    options: { 'requests-dir': { type: 'string' } },
    allowPositionals: true,
  });
  const dir = resolveRequestsDir(values['requests-dir'] as string | undefined);

  if (command === 'requests') {
    const requests = await listRequestFiles(dir);
    if (requests.length === 0) {
      console.log('No pending pane requests.');
      return 0;
    }
    for (const request of requests) {
      const ageSeconds = Math.round((Date.now() - request.createdAt) / 1000);
      console.log(`${request.id}  (${ageSeconds}s ago, ${request.kind})  ${request.reason}`);
      for (const candidate of request.candidates) {
        console.log(`    ${candidate.label}`);
      }
      console.log(`    grant with: tmux-mcp grant ${request.id} <target>`);
    }
    return 0;
  }

  const requestId = positionals[0];
  if (!requestId) {
    console.error(`Usage: tmux-mcp ${command} <request-id>${command === 'grant' ? ' <target>' : ' [reason]'}`);
    return 1;
  }

  const request = await readRequestFile(dir, requestId);
  if (!request) {
    console.error(`No pending request ${requestId} in ${dir}.`);
    return 1;
  }

  if (command === 'deny') {
    await writeAnswerFile(dir, requestId, 'deny', positionals.slice(1).join(' '));
    console.log(`Denied ${requestId}.`);
    return 0;
  }

  const target = positionals[1];
  if (!target) {
    console.error(`Usage: tmux-mcp grant ${requestId} <target>`);
    return 1;
  }
  if (!request.candidates.some(candidate => candidate.id === target)) {
    console.error(`${target} is not one of the candidates for ${requestId}. Offered:`);
    for (const candidate of request.candidates) console.error(`    ${candidate.label}`);
    return 1;
  }

  await writeAnswerFile(dir, requestId, 'grant', target);
  console.log(`Granted ${target} for ${requestId}.`);
  return 0;
}
```

In `src/index.ts`, at the very top of `main()` (before `parseArgs`), add:

```typescript
    // Subcommand dispatch: `tmux-mcp requests|grant|deny` is a CLI for humans,
    // not an MCP server run. It must not touch stdio used by the transport.
    const subcommand = process.argv[2];
    if (isGrantCliCommand(subcommand)) {
      process.exit(await runGrantCli(process.argv.slice(2)));
    }
```

and add the import:

```typescript
import { isGrantCliCommand, runGrantCli } from './cli-grant.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/grant-cli.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli-grant.ts src/index.ts test/grant-cli.test.mjs
git commit -m "feat: add requests/grant/deny CLI"
```

---

### Task 7: Assign hook

The extension point: any way of reaching a human that is not elicitation.

**Files:**
- Create: `src/assign-hook.ts`
- Test: `test/assign-hook.test.mjs`

**Interfaces:**
- Consumes: `PaneRequest`, `Answer` (Task 4).
- Produces: `spawnAssignHook(hookPath: string, request: PaneRequest, requestsDir: string, onAnswer: (answer: Answer) => void, log: (level: 'info' | 'warning', message: string) => void): () => void` — returns a kill function.

- [ ] **Step 1: Write the failing test**

Create `test/assign-hook.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { spawnAssignHook } from '../build/assign-hook.js';

const REQUEST = {
  id: 'r-abc123',
  reason: 'run the tests',
  kind: 'pane',
  createdAt: Date.now(),
  candidates: [
    { id: '%3', label: '%3  main:code.1  zsh  "logs"', windowId: '@1', sessionId: '$0' },
    { id: '%5', label: '%5  main:code.2  node  "server"', windowId: '@1', sessionId: '$0' },
  ],
};

async function hookScript(body) {
  const dir = await mkdtemp(join(tmpdir(), 'tmux-mcp-hook-'));
  const path = join(dir, 'hook.sh');
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

function runHook(path) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hook did not answer in time')), 5000);
    const kill = spawnAssignHook(path, REQUEST, '/tmp', answer => {
      clearTimeout(timer);
      resolve(answer);
    }, () => {});
    setTimeout(() => { kill(); clearTimeout(timer); resolve(null); }, 4000);
  });
}

test('a hook that prints a candidate id grants it', async () => {
  const path = await hookScript('echo "%5"');
  assert.deepEqual(await runHook(path), { status: 'granted', target: '%5', via: 'hook' });
});

test('a hook receives the request as JSON on stdin', async () => {
  const path = await hookScript('cat | sed -n "s/.*\\"reason\\": \\"\\([^\\"]*\\)\\".*/\\1/p" >/dev/null; echo "%3"');
  assert.deepEqual(await runHook(path), { status: 'granted', target: '%3', via: 'hook' });
});

test('a hook can read the request id from the environment', async () => {
  const path = await hookScript('test "$TMUX_MCP_REQUEST_ID" = "r-abc123" && echo "%3"');
  assert.deepEqual(await runHook(path), { status: 'granted', target: '%3', via: 'hook' });
});

test('deny with a reason is forwarded', async () => {
  const path = await hookScript('echo "deny: busy right now"');
  assert.deepEqual(await runHook(path), { status: 'denied', reason: 'busy right now', via: 'hook' });
});

test('bare deny is a denial without reason', async () => {
  const path = await hookScript('echo "deny"');
  assert.deepEqual(await runHook(path), { status: 'denied', reason: undefined, via: 'hook' });
});

test('a notify-only hook produces no answer', async () => {
  const path = await hookScript('exit 0');
  assert.equal(await runHook(path), null);
});

test('a failing hook produces no answer and is logged', async () => {
  const path = await hookScript('echo "%3"; exit 3');
  const logged = [];
  const answer = await new Promise(resolve => {
    spawnAssignHook(path, REQUEST, '/tmp', () => resolve('answered'), (level, msg) => logged.push([level, msg]));
    setTimeout(() => resolve(null), 2000);
  });
  assert.equal(answer, null);
  assert.ok(logged.some(([level]) => level === 'warning'));
});

test('unknown output is ignored', async () => {
  const path = await hookScript('echo "maybe later"');
  assert.equal(await runHook(path), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/assign-hook.test.mjs`
Expected: FAIL — `Cannot find module '../build/assign-hook.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/assign-hook.ts`:

```typescript
import { spawn } from 'node:child_process';
import type { Answer, PaneRequest } from './requests.js';

/**
 * Run the user's assign hook for one request.
 *
 * The hook receives the request as JSON on stdin plus TMUX_MCP_* env vars.
 * Its first line of stdout is the answer: a candidate id grants, `deny` or
 * `deny: reason` denies, empty output means it only notified the human and
 * the answer will arrive through another channel.
 *
 * Returns a function that kills the hook (used when another channel answers
 * first, or when the request expires).
 */
export function spawnAssignHook(
  hookPath: string,
  request: PaneRequest,
  requestsDir: string,
  onAnswer: (answer: Answer) => void,
  log: (level: 'info' | 'warning', message: string) => void
): () => void {
  const child = spawn(hookPath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TMUX_MCP_REQUEST_ID: request.id,
      TMUX_MCP_REASON: request.reason,
      TMUX_MCP_KIND: request.kind,
      TMUX_MCP_REQUESTS_DIR: requestsDir,
    },
  });

  const payload = {
    id: request.id,
    reason: request.reason,
    kind: request.kind,
    pid: process.pid,
    grantCommand: `tmux-mcp grant ${request.id} <target>`,
    candidates: request.candidates.map(c => ({ id: c.id, label: c.label })),
  };

  child.stdin.on('error', () => { /* hook may not read stdin */ });
  child.stdin.end(JSON.stringify(payload, null, 2));

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });

  child.on('error', error => {
    log('warning', `assign hook ${hookPath} failed to start: ${(error as Error).message}`);
  });

  child.on('close', code => {
    if (code !== 0) {
      log('warning', `assign hook exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`);
      return;
    }
    const answer = parseHookOutput(stdout, request);
    if (!answer) {
      log('info', `assign hook for ${request.id} returned no answer (notification only)`);
      return;
    }
    onAnswer(answer);
  });

  return () => {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  };
}

function parseHookOutput(stdout: string, request: PaneRequest): Answer | null {
  const line = stdout.split('\n').map(l => l.trim()).find(l => l.length > 0);
  if (!line) return null;
  if (line === 'deny') return { status: 'denied', reason: undefined, via: 'hook' };
  if (line.startsWith('deny:')) {
    const reason = line.slice('deny:'.length).trim();
    return { status: 'denied', reason: reason || undefined, via: 'hook' };
  }
  if (request.candidates.some(candidate => candidate.id === line)) {
    return { status: 'granted', target: line, via: 'hook' };
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/assign-hook.test.mjs`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/assign-hook.ts test/assign-hook.test.mjs
git commit -m "feat: add assign hook channel"
```

---

### Task 8: Elicitation channel

Ask through the MCP transport itself, so the LLM is not in the loop.

**Files:**
- Create: `src/elicit-channel.ts`
- Test: `test/elicit-channel.test.mjs`

**Interfaces:**
- Consumes: `PaneRequest`, `Answer` (Task 4).
- Produces:
  - `interface ElicitCapableServer { getClientCapabilities(): { elicitation?: unknown } | undefined; elicitInput(params: unknown, options?: unknown): Promise<{ action: string; content?: Record<string, unknown> }> }`
  - `clientSupportsElicitation(server: ElicitCapableServer): boolean`
  - `startElicitation(server, request, onAnswer, log): () => void` — returns an abort function

- [ ] **Step 1: Write the failing test**

Create `test/elicit-channel.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import test from 'node:test';

import { clientSupportsElicitation, startElicitation } from '../build/elicit-channel.js';

const REQUEST = {
  id: 'r-abc123',
  reason: 'run the tests',
  kind: 'pane',
  createdAt: Date.now(),
  candidates: [
    { id: '%3', label: '%3  main:code.1  zsh  "logs"', windowId: '@1', sessionId: '$0' },
    { id: '%5', label: '%5  main:code.2  node  "server"', windowId: '@1', sessionId: '$0' },
  ],
};

function fakeServer(behaviour, capabilities = { elicitation: {} }) {
  const calls = [];
  return {
    calls,
    getClientCapabilities: () => capabilities,
    elicitInput: async (params, options) => {
      calls.push({ params, options });
      return behaviour();
    },
  };
}

function answerOf(server) {
  return new Promise(resolve => {
    startElicitation(server, REQUEST, resolve, () => {});
    setTimeout(() => resolve(null), 1000);
  });
}

test('detects elicitation capability', () => {
  assert.equal(clientSupportsElicitation(fakeServer(() => {})), true);
  assert.equal(clientSupportsElicitation(fakeServer(() => {}, {})), false);
  assert.equal(clientSupportsElicitation({ getClientCapabilities: () => undefined }), false);
});

test('accept becomes a grant and the schema offers every candidate', async () => {
  const server = fakeServer(() => ({ action: 'accept', content: { target: '%5' } }));
  const answer = await answerOf(server);
  assert.deepEqual(answer, { status: 'granted', target: '%5', via: 'elicitation' });

  const schema = server.calls[0].params.requestedSchema;
  assert.deepEqual(schema.properties.target.enum, ['%3', '%5', 'deny']);
  assert.equal(schema.properties.target.enumNames.length, 3);
  assert.match(server.calls[0].params.message, /run the tests/);
});

test('choosing deny in the form is a denial', async () => {
  const server = fakeServer(() => ({ action: 'accept', content: { target: 'deny' } }));
  assert.deepEqual(await answerOf(server), { status: 'denied', reason: undefined, via: 'elicitation' });
});

test('decline is a denial', async () => {
  const server = fakeServer(() => ({ action: 'decline' }));
  assert.deepEqual(await answerOf(server), { status: 'denied', reason: undefined, via: 'elicitation' });
});

test('cancel produces no answer, leaving other channels to decide', async () => {
  const server = fakeServer(() => ({ action: 'cancel' }));
  assert.equal(await answerOf(server), null);
});

test('a throwing client produces no answer and is logged', async () => {
  const server = fakeServer(() => { throw new Error('not supported'); });
  const logged = [];
  const answer = await new Promise(resolve => {
    startElicitation(server, REQUEST, resolve, (level, msg) => logged.push([level, msg]));
    setTimeout(() => resolve(null), 500);
  });
  assert.equal(answer, null);
  assert.ok(logged.some(([level]) => level === 'warning'));
});

test('an unknown target from the client is ignored', async () => {
  const server = fakeServer(() => ({ action: 'accept', content: { target: '%99' } }));
  assert.equal(await answerOf(server), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/elicit-channel.test.mjs`
Expected: FAIL — `Cannot find module '../build/elicit-channel.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/elicit-channel.ts`:

```typescript
import type { Answer, PaneRequest } from './requests.js';

/**
 * The slice of the MCP Server class this channel needs. Declared structurally
 * so tests can pass a fake without constructing a real server.
 */
export interface ElicitCapableServer {
  getClientCapabilities(): { elicitation?: unknown } | undefined;
  elicitInput(
    params: {
      message: string;
      requestedSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
      };
    },
    options?: { timeout?: number; signal?: AbortSignal }
  ): Promise<{ action: string; content?: Record<string, unknown> }>;
}

/** Matches the request expiry in the spec, so the prompt outlives the tool call. */
const ELICITATION_TIMEOUT_MS = 30 * 60 * 1000;

export function clientSupportsElicitation(server: ElicitCapableServer): boolean {
  return server.getClientCapabilities()?.elicitation !== undefined;
}

/**
 * Ask the human through the MCP client. The prompt stays open after the
 * tool call returns `pending`; abort it when another channel answers first.
 */
export function startElicitation(
  server: ElicitCapableServer,
  request: PaneRequest,
  onAnswer: (answer: Answer) => void,
  log: (level: 'info' | 'warning', message: string) => void
): () => void {
  const controller = new AbortController();
  const noun = request.kind === 'pane' ? 'pane' : 'window';

  const params = {
    message: `The agent is asking for a tmux ${noun}.\n\nReason: ${request.reason}\n\nPick the ${noun} it may use, or choose "deny".`,
    requestedSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          title: `tmux ${noun}`,
          description: `The ${noun} the agent may use.`,
          enum: [...request.candidates.map(c => c.id), 'deny'],
          enumNames: [...request.candidates.map(c => c.label), 'Deny this request'],
        },
      },
      required: ['target'],
    },
  };

  void server.elicitInput(params, { timeout: ELICITATION_TIMEOUT_MS, signal: controller.signal })
    .then(result => {
      if (controller.signal.aborted) return;
      if (result.action === 'decline') {
        onAnswer({ status: 'denied', reason: undefined, via: 'elicitation' });
        return;
      }
      if (result.action !== 'accept') return; // 'cancel': leave it to other channels
      const target = result.content?.target;
      if (target === 'deny') {
        onAnswer({ status: 'denied', reason: undefined, via: 'elicitation' });
        return;
      }
      if (typeof target === 'string' && request.candidates.some(c => c.id === target)) {
        onAnswer({ status: 'granted', target, via: 'elicitation' });
        return;
      }
      log('warning', `elicitation for ${request.id} returned an unusable target`);
    })
    .catch(error => {
      if (controller.signal.aborted) return;
      log('warning', `elicitation for ${request.id} failed: ${(error as Error).message}`);
    });

  return () => controller.abort();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/elicit-channel.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/elicit-channel.ts test/elicit-channel.test.mjs
git commit -m "feat: add elicitation channel for pane requests"
```

---

### Task 9: The `request-pane` tool

Wire the registry and all three channels into one tool, registered only in human-assigned mode.

**Files:**
- Modify: `src/index.ts` (new tool, notification helper, `main()` wiring)
- Test: `test/human-assigned.test.mjs` (extend)

**Interfaces:**
- Consumes: everything from Tasks 1-8.
- Produces: MCP tool `request-pane` with input `{ reason: string; kind?: 'pane' | 'window'; timeoutSeconds?: number; requestId?: string }`.

- [ ] **Step 1: Write the failing test**

Append to `test/human-assigned.test.mjs`:

```javascript
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function resultText(result) {
  assert.equal(result.content[0]?.type, 'text');
  return result.content[0].text;
}

async function startHumanAssignedServer(extraArgs = []) {
  const requestsDir = await mkdtemp(join(tmpdir(), 'tmux-mcp-ha-'));
  const client = new Client({ name: 'human-assigned-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js', '--human-assigned', `--requests-dir=${requestsDir}`, ...extraArgs],
    cwd: process.cwd(),
    stderr: 'pipe',
  });
  await client.connect(transport);
  return { client, transport, requestsDir };
}

test('without a grant the agent sees nothing and can request a pane', async () => {
  const sessionName = `tmux-mcp-ha-${process.pid}-${randomUUID()}`;
  const paneId = await executeTmux(['new-session', '-d', '-s', sessionName, '-P', '-F', '#{pane_id}']);
  const { client, transport, requestsDir } = await startHumanAssignedServer();

  try {
    const sessions = await client.callTool({ name: 'list-sessions', arguments: {} });
    assert.equal(JSON.parse(resultText(sessions)).length, 0);

    const denied = await client.callTool({
      name: 'capture-pane',
      arguments: { paneId, lines: 5 },
    });
    assert.equal(denied.isError, true);
    assert.match(resultText(denied), /not in the allowed|Access denied/i);

    // The request returns pending; the human answers out of band.
    const pending = client.callTool({
      name: 'request-pane',
      arguments: { reason: 'run the test suite', timeoutSeconds: 20 },
    });

    const requestId = await waitForRequestId(requestsDir);
    const request = JSON.parse(await readFile(join(requestsDir, `${requestId}.json`), 'utf8'));
    assert.equal(request.reason, 'run the test suite');
    assert.ok(request.candidates.some(candidate => candidate.id === paneId));

    await writeFile(join(requestsDir, `${requestId}.grant`), paneId, { mode: 0o600 });

    const granted = await pending;
    assert.equal(granted.isError, false);
    assert.match(resultText(granted), /^Status: granted$/m);
    assert.match(resultText(granted), new RegExp(`Pane: ${paneId.replace('%', '\\%')}`));

    // The granted pane is now usable and visible.
    const after = await client.callTool({ name: 'capture-pane', arguments: { paneId, lines: 5 } });
    assert.equal(after.isError, false);
    const sessionsAfter = await client.callTool({ name: 'list-sessions', arguments: {} });
    assert.equal(JSON.parse(resultText(sessionsAfter)).length, 1);
  } finally {
    await transport.close();
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});

test('an unanswered request returns pending and can be polled', async () => {
  const sessionName = `tmux-mcp-ha-${process.pid}-${randomUUID()}`;
  const paneId = await executeTmux(['new-session', '-d', '-s', sessionName, '-P', '-F', '#{pane_id}']);
  const { client, transport, requestsDir } = await startHumanAssignedServer();

  try {
    const first = await client.callTool({
      name: 'request-pane',
      arguments: { reason: 'later', timeoutSeconds: 1 },
    });
    assert.match(resultText(first), /^Status: pending$/m);
    const requestId = resultText(first).match(/Request ID: (r-[a-z0-9]+)/)[1];

    await writeFile(join(requestsDir, `${requestId}.grant`), paneId, { mode: 0o600 });

    const polled = await client.callTool({
      name: 'request-pane',
      arguments: { reason: 'later', requestId, timeoutSeconds: 10 },
    });
    assert.match(resultText(polled), /^Status: granted$/m);
  } finally {
    await transport.close();
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});

test('a denial is reported to the agent with its reason', async () => {
  const sessionName = `tmux-mcp-ha-${process.pid}-${randomUUID()}`;
  await executeTmux(['new-session', '-d', '-s', sessionName]);
  const { client, transport, requestsDir } = await startHumanAssignedServer();

  try {
    const pendingCall = client.callTool({
      name: 'request-pane',
      arguments: { reason: 'nope', timeoutSeconds: 20 },
    });
    const requestId = await waitForRequestId(requestsDir);
    await writeFile(join(requestsDir, `${requestId}.deny`), 'busy right now', { mode: 0o600 });

    const result = await pendingCall;
    assert.equal(result.isError, true);
    assert.match(resultText(result), /^Status: denied$/m);
    assert.match(resultText(result), /busy right now/);
  } finally {
    await transport.close();
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});

async function waitForRequestId(dir) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const entries = await readdir(dir);
    const file = entries.find(entry => entry.endsWith('.json'));
    if (file) return file.slice(0, -'.json'.length);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('no request file appeared');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/human-assigned.test.mjs`
Expected: FAIL — `Tool request-pane not found`.

- [ ] **Step 3: Write minimal implementation**

In `src/index.ts` add the imports:

```typescript
import { addGrant } from './grants.js';
import { buildCandidates, createRequest, getRequest, answerRequest, waitForAnswer, onRequestSettled, expireRequests, listPendingRequests } from './requests.js';
import type { Answer, PaneRequest } from './requests.js';
import { resolveRequestsDir, writeRequestFile, removeRequestFiles, startAnswerWatcher } from './requests-dir.js';
import { spawnAssignHook } from './assign-hook.js';
import { clientSupportsElicitation, startElicitation } from './elicit-channel.js';
```

Add module state and helpers above the tool registrations:

```typescript
// Resolved in main(); the tool only runs after the server is connected.
let requestsDir = '';
let assignHookPath: string | undefined;
const REQUEST_EXPIRY_MS = 30 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 30;
// Channel teardown functions per request id, run once the request settles.
const requestCleanups = new Map<string, Array<() => void>>();

function logToClient(level: 'info' | 'warning', message: string): void {
  void server.server.sendLoggingMessage({ level, data: `[human-assigned] ${message}` }).catch(() => { /* ignore */ });
}

/** Best-effort human-visible ping on every attached tmux client. */
async function notifyAttachedClients(request: PaneRequest): Promise<void> {
  try {
    await tmux.executeTmux([
      'display-message', '-a',
      `tmux-mcp: agent requests a ${request.kind} (${request.reason}) — tmux-mcp grant ${request.id} <target>`,
    ]);
  } catch {
    // No tmux server or no attached client: the other channels still work.
  }
}

function cleanupRequest(id: string): void {
  for (const stop of requestCleanups.get(id) ?? []) {
    try { stop(); } catch { /* already stopped */ }
  }
  requestCleanups.delete(id);
  void removeRequestFiles(requestsDir, id).catch(() => { /* ignore */ });
}
```

Register the tool (only in human-assigned mode) after the `new-pane-smart` registration:

```typescript
if (humanAssigned) {
  server.tool(
    "request-pane",
    "Ask a human to assign you a tmux pane (or window). In human-assigned mode you start with access to nothing: no pane is visible or usable until a human hands you one with this tool. Give a short, honest `reason` — the human reads it verbatim before deciding. Returns Status: granted with the pane id, Status: denied, or Status: pending with a Request ID when the human has not answered yet. On pending, call this tool again with that requestId to keep waiting; the request stays open for 30 minutes.",
    {
      reason: z.string().min(1).max(200).describe("Why you need the pane. Shown to the human verbatim, so be specific: 'run the test suite', 'tail the dev server log'."),
      kind: z.enum(["pane", "window"]).optional().describe("Ask for a single pane (default) or a whole window (every pane inside it becomes usable)."),
      timeoutSeconds: z.number().min(1).optional().describe(`How long to wait for the human before returning Status: pending. Default ${DEFAULT_REQUEST_TIMEOUT_SECONDS}s.`),
      requestId: z.string().optional().describe("Poll an earlier request that returned Status: pending. When set, `reason` is ignored and no new request is created."),
    },
    async ({ reason, kind, timeoutSeconds, requestId }) => {
      try {
        expireRequests(REQUEST_EXPIRY_MS);
        const waitSeconds = timeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS;
        const timeoutCheck = checkBlockingTimeout(waitSeconds);
        if (!timeoutCheck.ok) {
          return { content: [{ type: "text", text: timeoutCheck.message }], isError: true };
        }

        let request: PaneRequest | undefined;
        if (requestId) {
          request = getRequest(requestId);
          if (!request) {
            return {
              content: [{ type: "text", text: `Status: expired\nRequest ID: ${requestId}\nThe request is no longer pending (answered, expired, or unknown). Call request-pane again with a reason to ask afresh.` }],
              isError: true,
            };
          }
        } else {
          const requestKind = kind ?? 'pane';
          const candidates = await buildCandidates(requestKind);
          if (candidates.length === 0) {
            return {
              content: [{ type: "text", text: `Status: no_candidates\nThere is no ${requestKind} a human could assign right now.` }],
              isError: true,
            };
          }
          request = createRequest(reason, requestKind, candidates);
          await writeRequestFile(requestsDir, request);
          void notifyAttachedClients(request);
          logToClient('info', `pane request ${request.id}: ${reason}`);

          const cleanups: Array<() => void> = [];
          if (clientSupportsElicitation(server.server)) {
            cleanups.push(startElicitation(server.server, request, answer => {
              answerRequest(request!.id, answer);
            }, logToClient));
          }
          if (assignHookPath) {
            cleanups.push(spawnAssignHook(assignHookPath, request, requestsDir, answer => {
              answerRequest(request!.id, answer);
            }, logToClient));
          }
          requestCleanups.set(request.id, cleanups);
        }

        const answer = await waitForAnswer(request.id, waitSeconds * 1000);
        if (!answer) {
          return {
            content: [{ type: "text", text: `Status: pending\nRequest ID: ${request.id}\nNobody has answered yet. Call request-pane again with requestId="${request.id}" to keep waiting, or do something else in the meantime. The request stays open for 30 minutes.` }],
          };
        }
        if (answer.status === 'denied') {
          return {
            content: [{ type: "text", text: `Status: denied\nRequest ID: ${request.id}${answer.reason ? `\nReason: ${answer.reason}` : ''}\nThe human declined. Do not retry the same request without new information.` }],
            isError: true,
          };
        }
        const label = request.candidates.find(c => c.id === answer.target)?.label ?? answer.target;
        const noun = request.kind === 'pane' ? 'Pane' : 'Window';
        return {
          content: [{ type: "text", text: `Status: granted\n${noun}: ${answer.target}\nAssigned via: ${answer.via}\nDetails: ${label}\nYou may now use this ${request.kind}. Everything else remains off limits.` }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error requesting a pane: ${error}` }], isError: true };
      }
    }
  );
}
```

In `main()`, after `initHumanAssigned(humanAssigned);`, add:

```typescript
    requestsDir = resolveRequestsDir(values['requests-dir'] as string | undefined);
    assignHookPath = (values['assign-hook'] as string | undefined) ?? process.env.TMUX_MCP_ASSIGN_HOOK;
```

and after `await server.connect(transport);` add:

```typescript
    if (humanAssigned) {
      // A granted request becomes a grant, and its channels are torn down.
      onRequestSettled((id, answer: Answer) => {
        if (answer.status === 'granted') {
          const request = pendingRequestSnapshots.get(id);
          const candidate = request?.candidates.find(c => c.id === answer.target);
          if (candidate) {
            addGrant({
              kind: request!.kind,
              id: candidate.id,
              windowId: candidate.windowId,
              sessionId: candidate.sessionId,
            });
            logToClient('info', `granted ${candidate.id} via ${answer.via}`);
            try { server.sendResourceListChanged(); } catch { /* ignore */ }
          }
        }
        pendingRequestSnapshots.delete(id);
        cleanupRequest(id);
      });

      const stopWatcher = startAnswerWatcher(requestsDir, (id, answer) => {
        if (!answerRequest(id, answer)) {
          logToClient('warning', `ignored answer for ${id} (unknown request or invalid target)`);
        }
      });
      process.once('exit', stopWatcher);
    }
```

`answerRequest` deletes the request before listeners run, so keep a snapshot for the settle listener. Add next to `requestCleanups`:

```typescript
// The registry drops a request when it settles; the settle listener still
// needs its candidates to turn the answer into a grant.
const pendingRequestSnapshots = new Map<string, PaneRequest>();
```

and store it right after `createRequest(...)`:

```typescript
          pendingRequestSnapshots.set(request.id, request);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/human-assigned.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/human-assigned.test.mjs
git commit -m "feat: add request-pane tool with three answer channels"
```

---

### Task 10: Derived access, disabled tools and stale-grant pruning

A granted pane may be split (the child is inside what the human gave); everything that would widen access beyond the grant is switched off.

**Files:**
- Modify: `src/index.ts` (`split-pane`, `new-pane`, `new-pane-smart`, `disableToolsByScope`, watcher callback)
- Test: `test/human-assigned.test.mjs` (extend), `test/tool-registration.test.mjs` (extend)

**Interfaces:**
- Consumes: `addGrant`, `pruneGrants` (Task 1), `listAllPanes`, `listAllWindowIds` (Task 3).
- Produces: `autoGrantNewPane(paneId: string): Promise<void>` in `src/index.ts`.

- [ ] **Step 1: Write the failing test**

Append to `test/human-assigned.test.mjs`:

```javascript
test('splitting a granted pane grants the child pane', async () => {
  const sessionName = `tmux-mcp-ha-${process.pid}-${randomUUID()}`;
  const paneId = await executeTmux(['new-session', '-d', '-s', sessionName, '-P', '-F', '#{pane_id}']);
  const { client, transport, requestsDir } = await startHumanAssignedServer();

  try {
    const pendingCall = client.callTool({
      name: 'request-pane',
      arguments: { reason: 'need a workspace', timeoutSeconds: 20 },
    });
    const requestId = await waitForRequestId(requestsDir);
    await writeFile(join(requestsDir, `${requestId}.grant`), paneId, { mode: 0o600 });
    await pendingCall;

    const split = await client.callTool({
      name: 'split-pane',
      arguments: { paneId, direction: 'vertical' },
    });
    assert.equal(split.isError, false);
    const childId = resultText(split).match(/"id": "(%\d+)"/)[1];

    // The child is usable without a second request.
    const capture = await client.callTool({ name: 'capture-pane', arguments: { paneId: childId, lines: 5 } });
    assert.equal(capture.isError, false);
  } finally {
    await transport.close();
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});
```

Append to `test/tool-registration.test.mjs`:

```javascript
test('human-assigned mode registers request-pane and drops creation tools', async () => {
  const client = new Client({ name: 'human-assigned-registration', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js', '--human-assigned'],
    cwd: process.cwd(),
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map(tool => tool.name);

    assert.ok(names.includes('request-pane'));
    assert.ok(!names.includes('create-session'));
    assert.ok(!names.includes('create-window'));
    assert.ok(!names.includes('move-window'));

    const requestTool = tools.find(tool => tool.name === 'request-pane');
    assert.deepEqual(Object.keys(requestTool.inputSchema.properties ?? {}).sort(), [
      'reason', 'kind', 'timeoutSeconds', 'requestId',
    ].sort());
    assert.deepEqual([...(requestTool.inputSchema.required ?? [])], ['reason']);
    assert.match(requestTool.description ?? '', /start with access to nothing/i);
  } finally {
    await transport.close();
  }
});

test('without the flag request-pane is not registered', async () => {
  const client = new Client({ name: 'default-registration', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js'],
    cwd: process.cwd(),
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(!tools.map(tool => tool.name).includes('request-pane'));
  } finally {
    await transport.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/human-assigned.test.mjs test/tool-registration.test.mjs`
Expected: FAIL — the split child is denied by `capture-pane`, and `create-session` is still listed.

- [ ] **Step 3: Write minimal implementation**

In `src/index.ts`, add the helper next to `cleanupRequest`:

```typescript
/**
 * A pane split off a granted pane lives inside what the human handed over,
 * so it inherits the grant. Without this the agent would have to ask again
 * for a pane it just created.
 */
async function autoGrantNewPane(paneId: string): Promise<void> {
  if (!humanAssigned) return;
  try {
    const { windowId, sessionId } = await tmux.getPaneLocation(paneId);
    addGrant({ kind: 'pane', id: paneId, windowId, sessionId });
  } catch {
    logToClient('warning', `could not auto-grant new pane ${paneId}`);
  }
}
```

Call it in all three split sites, immediately after a successful split:
- `split-pane` (`src/index.ts:538`): after `const newPane = await tmux.splitPane(...)`, inside the `if (newPane)` branch — add `await autoGrantNewPane(newPane.id);`
- `new-pane` (`src/index.ts:592`): same, inside `if (newPane) {`
- `new-pane-smart` (`src/index.ts:702`): same, inside `if (newPane) {`

In `new-pane-smart`, disable the new-window fallback. Replace the `if (getScopeMode() === 'window')` guard with:

```typescript
      if (getScopeMode() === 'window' || isHumanAssigned()) {
        return {
          content: [{
            type: "text",
            text: isHumanAssigned()
              ? `No assigned pane has enough room to split (min ${NEW_PANE_SMART_MIN_WIDTH}x${NEW_PANE_SMART_MIN_HEIGHT}). Ask a human for another pane with request-pane.`
              : `No pane in window ${targetWindowId} has enough room to split (min ${NEW_PANE_SMART_MIN_WIDTH}x${NEW_PANE_SMART_MIN_HEIGHT}), and scope=window blocks creating new windows. Resize the window or use a different scope.`
          }],
          isError: true
        };
      }
```

Extend `disableToolsByScope()`:

```typescript
function disableToolsByScope(): void {
  if (humanAssigned) {
    // Nothing may be created outside what a human assigned.
    createSessionTool.disable();
    createWindowTool.disable();
    moveWindowTool.disable();
  }

  const mode = getScopeMode();
  if (mode === 'none') return;
  ...
}
```

(`disable()` is idempotent, so the window-scope branch may disable the same tools again.)

Prune stale grants when the structure changes. In `main()`, extend the watcher callback:

```typescript
    const watcher = new ResourceChangeWatcher({
      onListChanged: () => {
        if (humanAssigned) void pruneStaleGrants();
        try { server.sendResourceListChanged(); } catch { /* ignore */ }
      },
```

and add next to `autoGrantNewPane`:

```typescript
/** Forget grants whose pane or window has disappeared. */
async function pruneStaleGrants(): Promise<void> {
  try {
    const panes = await tmux.listAllPanes();
    const windowIds = await tmux.listAllWindowIds();
    const removed = pruneGrants(
      new Set(panes.map(pane => pane.paneId)),
      new Set(windowIds)
    );
    if (removed.length > 0) {
      logToClient('info', `dropped grants for closed resources: ${removed.join(', ')}`);
    }
  } catch {
    // tmux unavailable: keep the grants; every tool still validates on use.
  }
}
```

Add `pruneGrants` to the `./grants.js` import.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/human-assigned.test.mjs test/tool-registration.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/human-assigned.test.mjs test/tool-registration.test.mjs
git commit -m "feat: inherit grants on split and disable widening tools"
```

---

### Task 11: Example hooks and documentation

**Files:**
- Create: `examples/assign-hooks/tmux-popup.sh`, `examples/assign-hooks/macos-dialog.sh`, `examples/assign-hooks/notify-only.sh`
- Modify: `README.md`
- Test: `test/assign-hook.test.mjs` (extend with a shipped-example smoke test)

**Interfaces:**
- Consumes: the hook contract from Task 7.
- Produces: nothing importable.

- [ ] **Step 1: Write the failing test**

Append to `test/assign-hook.test.mjs`:

```javascript
import { access, constants } from 'node:fs/promises';

test('shipped example hooks are executable and follow the contract', async () => {
  for (const name of ['tmux-popup.sh', 'macos-dialog.sh', 'notify-only.sh']) {
    await access(new URL(`../examples/assign-hooks/${name}`, import.meta.url), constants.X_OK);
  }
  // notify-only never answers, whatever the request looks like.
  const answer = await new Promise(resolve => {
    spawnAssignHook(
      new URL('../examples/assign-hooks/notify-only.sh', import.meta.url).pathname,
      REQUEST,
      '/tmp',
      () => resolve('answered'),
      () => {}
    );
    setTimeout(() => resolve(null), 2500);
  });
  assert.equal(answer, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/assign-hook.test.mjs`
Expected: FAIL — `ENOENT` on `examples/assign-hooks/tmux-popup.sh`.

- [ ] **Step 3: Write minimal implementation**

Create `examples/assign-hooks/tmux-popup.sh`:

```bash
#!/bin/sh
# Assign hook: ask in a tmux popup on the most recently active client.
#
#   --assign-hook /path/to/tmux-popup.sh
#
# Requires tmux >= 3.2 and an attached client. Prints the chosen target on
# stdout, which grants it; printing nothing leaves the request pending.
set -eu

request=$(cat)
answer_file=$(mktemp)
trap 'rm -f "$answer_file"' EXIT

# Build the prompt body: the reason plus one line per candidate.
prompt=$(printf '%s' "$request" | sed -n 's/.*"reason": "\(.*\)",/Reason: \1/p')
candidates=$(printf '%s' "$request" | sed -n 's/.*"label": "\(.*\)"$/  \1/p')

tmux display-popup -E -w 80 -h 20 \
  "printf '%s\n\n%s\n\n' 'Agent requests a tmux pane.' '$prompt$(printf '\n')$candidates'; \
   printf 'Pane id to assign (empty = decide later): '; \
   read -r target; printf '%s' \"\$target\" > '$answer_file'" </dev/null >/dev/null 2>&1 || exit 0

cat "$answer_file"
```

Create `examples/assign-hooks/macos-dialog.sh`:

```bash
#!/bin/sh
# Assign hook: ask in a macOS dialog, so the human does not need to be
# looking at tmux.
#
#   --assign-hook /path/to/macos-dialog.sh
#
# Requires a GUI session (does not work over plain SSH).
set -eu

request=$(cat)
reason=$(printf '%s' "$request" | sed -n 's/.*"reason": "\(.*\)",/\1/p')
candidates=$(printf '%s' "$request" | sed -n 's/.*"label": "\(.*\)"$/\1/p')

message="An agent requests a tmux pane.

Reason: $reason

$candidates

Type the pane id to assign, or leave empty to decide later:"

target=$(osascript -e "display dialog \"$message\" default answer \"\" with title \"tmux-mcp\"" \
  -e 'text returned of result' 2>/dev/null) || exit 0

printf '%s' "$target"
```

Create `examples/assign-hooks/notify-only.sh`:

```bash
#!/bin/sh
# Assign hook: only notify; the human answers with `tmux-mcp grant`.
#
#   --assign-hook /path/to/notify-only.sh
#
# Works headless and over SSH. Prints nothing, so the request stays pending
# until a grant arrives through the CLI.
set -eu

request=$(cat)
reason=${TMUX_MCP_REASON:-$(printf '%s' "$request" | sed -n 's/.*"reason": "\(.*\)",/\1/p')}
body="tmux-mcp grant ${TMUX_MCP_REQUEST_ID} <target>"

if command -v terminal-notifier >/dev/null 2>&1; then
  terminal-notifier -title 'tmux-mcp' -subtitle "$reason" -message "$body" >/dev/null 2>&1 || true
elif command -v notify-send >/dev/null 2>&1; then
  notify-send 'tmux-mcp' "$reason
$body" >/dev/null 2>&1 || true
fi

exit 0
```

Make them executable:

```bash
chmod +x examples/assign-hooks/*.sh
```

Add to `README.md`, after the existing scope section (around line 89):

````markdown
### Human-assigned access

`--human-assigned` starts the agent with access to **nothing**: no session,
window or pane is visible or usable. The agent asks for one with the
`request-pane` tool, a human assigns it, and only then does it enter scope.
Splitting an assigned pane yields another assigned pane; everything else stays
off limits. It combines with `--scope`: an assignment outside the static scope
is refused.

| Flag | Env | Default | Description |
| --- | --- | --- | --- |
| `--human-assigned` | `TMUX_MCP_HUMAN_ASSIGNED` | off | Start with no access; every pane is assigned by a human |
| `--assign-hook=<path>` | `TMUX_MCP_ASSIGN_HOOK` | — | Script that reaches the human (see below) |
| `--requests-dir=<path>` | `TMUX_MCP_REQUESTS_DIR` | `~/.tmux-mcp/requests` | Where pending requests are stored |

A request can be answered through three channels, whichever comes first:

1. **Elicitation** — used automatically when the MCP client supports it. The
   question appears in the client's own UI (Claude Code shows a prompt), so the
   LLM never sees or authors the answer.
2. **The CLI** — from any shell, including over SSH:

   ```bash
   tmux-mcp requests                  # what is pending, with the candidates
   tmux-mcp grant r-8f3k2 %3          # assign pane %3
   tmux-mcp deny r-8f3k2 "not now"
   ```

3. **An assign hook** — your own script, for any other way of asking.

#### Assign hook contract

The hook is spawned once per request, receives the request as JSON on stdin
(`id`, `reason`, `kind`, `candidates[].id`, `candidates[].label`,
`grantCommand`) plus `TMUX_MCP_REQUEST_ID`, `TMUX_MCP_REASON`,
`TMUX_MCP_KIND` and `TMUX_MCP_REQUESTS_DIR` in the environment.

| First line of stdout | Meaning |
| --- | --- |
| a candidate id (`%3`, `@2`) | assign that target |
| `deny` or `deny: <reason>` | refuse, reason forwarded to the agent |
| empty, exit 0 | notification only; answer later via the CLI |
| anything else, or exit ≠ 0 | logged and ignored; the request stays pending |

Ready-made examples in [`examples/assign-hooks/`](examples/assign-hooks):
`tmux-popup.sh` (popup in tmux), `macos-dialog.sh` (GUI dialog),
`notify-only.sh` (desktop notification, answer with the CLI).

> **Scope is only as strong as the agent's other tools.** An agent that can
> also run arbitrary shell commands can call `tmux` directly and bypass this
> server entirely. `--human-assigned` restricts this MCP server, not tmux.
````

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/assign-hook.test.mjs`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add examples/assign-hooks README.md test/assign-hook.test.mjs
git commit -m "docs: document human-assigned mode and ship example hooks"
```

---

### Task 12: Full-suite verification

**Files:**
- Modify: whichever files the run turns up as broken.

**Interfaces:**
- Consumes: everything.
- Produces: a green `npm test`.

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: every test file passes. The suite starts real tmux sessions, so a tmux binary must be available.

- [ ] **Step 2: Check for leaked tmux sessions**

Run: `tmux list-sessions 2>/dev/null | grep tmux-mcp- || echo "no leaked sessions"`
Expected: `no leaked sessions`. If any remain, the test that created them is missing its `finally` cleanup — fix it.

- [ ] **Step 3: Manual smoke test of the elicitation channel**

Run the server from a real Claude Code session with `--human-assigned`, ask the agent to call `request-pane`, and confirm the prompt appears in the client UI and that a chosen pane becomes usable. Note in the commit message whether the client kept the tool call open or returned `pending` first — both are correct behaviour by design.

- [ ] **Step 4: Fix anything the run surfaced, then commit**

```bash
git add -A
git commit -m "test: verify human-assigned scope end to end"
```

---

## Self-Review Notes

Spec coverage check against `docs/plans/2026-09-02-human-assigned-scope-design.md`:

| Spec section | Task |
| --- | --- |
| CLI flags (`--human-assigned`, `--assign-hook`, `--requests-dir`) | 2, 9 |
| `tmux-mcp requests/grant/deny` | 6 |
| Scope semantics table (pane/window/session) | 1, 2 |
| Intersection with static scope | 2, 4 |
| Derived access on split | 10 |
| `new-pane-smart` fallback disabled | 10 |
| Creation tools disabled | 10 |
| Grant removal when a resource disappears | 1, 10 |
| `request-pane` inputs and flow steps 1-6 | 9 |
| Candidate list excludes self and granted | 4 |
| Notification on attached clients / MCP log | 9 |
| Elicitation channel | 8 |
| Grant channel + file watching | 5, 9 |
| Assign hook + output contract | 7 |
| Example hooks | 11 |
| Expiry after 30 minutes | 4, 9 |
| Tool descriptions mention assignment | 9, 11 |
| Security notes documented | 11 |

**Resolved from the spec's open question:** the default `request-pane` timeout is 30s, below the 60s client cap, so the tool always returns cleanly and the request keeps living server-side. Correctness no longer depends on how a given client treats a long-running elicitation; Task 12 step 3 records the observed behaviour for documentation only.

**Dropped from the spec:** `tmux-mcp requests --prune` and the stale-pid display. Pending requests live in server memory, so a dead server's files are only ever noise in `tmux-mcp requests`; a plain `rm` of the requests dir suffices and no code is needed to say so.
