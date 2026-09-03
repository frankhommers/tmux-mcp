# Dispatch — Milestone 1 (Inbox) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One local web daemon, shared by every tmux-mcp server on the machine, where a human sees pending pane requests, refreshes a live list of assignable panes, and assigns or denies — replacing MCP elicitation entirely.

**Architecture:** `~/.tmux-mcp/requests/` is already a shared bus: servers write `<id>.json` and watch for `<id>.grant`/`<id>.deny`. The daemon is a second consumer of that same protocol, so it needs no coordination with the MCP servers beyond being started. It is a plain `node:http` server on loopback, discovered through `~/.tmux-mcp/ui.json`, auto-spawned by the MCP server under an exclusive lock, and outliving the agents that spawned it.

**Tech Stack:** TypeScript (ES2022, NodeNext, `strict: true`), `node:http`, `node:fs`, Server-Sent Events, one dependency-free HTML/CSS/ES-module page. Tests with `node --test` against the compiled `build/` output, driving the daemon with `fetch`.

**Spec:** `docs/plans/2026-09-02-control-ui-design.md` (milestone 1 only; milestones 2 and 3 get their own plans)

## Global Constraints

- All source in `src/`, compiled to `build/` by `npm run build` (`tsc`), `strict: true`.
- ESM only. Relative imports inside `src/` carry the `.js` extension.
- **No new runtime dependencies in this milestone.** `@xterm/xterm` belongs to milestone 3.
- Tests are `.mjs` in `test/`, run by `npm test`, importing from `../build/*.js`, never `../src/`.
- Tests that touch tmux create their own session named `tmux-mcp-<purpose>-${process.pid}-${randomUUID()}` and kill it in a `finally`.
- Tests that start the daemon always pass an isolated state dir and `--port=0`, and stop it in a `finally`. Never touch `~/.tmux-mcp`.
- The daemon binds `127.0.0.1` only. Every endpoint except `GET /api/health` requires `Authorization: Bearer <token>`. `Host` must be `127.0.0.1[:port]` or `localhost[:port]`; when `Origin` is present it must equal the server's own origin.
- `ui.json` and request files are mode `0600` inside a `0700` directory.
- Static assets are served from `build/ui/public/`. `tsc` does not copy non-TS files, so the build script must copy them (Task 6).
- Commit after every task. Never add Co-Authored-By or mention any LLM/agent in commit messages.

---

### Task 1: Daemon state file, liveness and locking

Everything else depends on being able to answer "is a daemon already running, and where?".

**Files:**
- Create: `src/ui/state.ts`
- Test: `test/ui-state.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface UiState { pid: number; port: number; token: string; startedAt: number; version: string }`
  - `resolveStateDir(cliValue?: string): string` — `~/.tmux-mcp` unless overridden (`TMUX_MCP_STATE_DIR`)
  - `stateFilePath(stateDir: string): string`
  - `writeUiState(stateDir: string, state: UiState): Promise<void>`
  - `readUiState(stateDir: string): Promise<UiState | null>`
  - `clearUiState(stateDir: string): Promise<void>`
  - `isProcessAlive(pid: number): boolean`
  - `acquireSpawnLock(stateDir: string, staleMs?: number): Promise<boolean>`
  - `releaseSpawnLock(stateDir: string): Promise<void>`
  - `newToken(): string` — 32 hex characters

- [ ] **Step 1: Write the failing test**

Create `test/ui-state.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  writeUiState,
  readUiState,
  clearUiState,
  isProcessAlive,
  acquireSpawnLock,
  releaseSpawnLock,
  newToken,
  stateFilePath,
} from '../build/ui/state.js';

const STATE = { pid: process.pid, port: 7676, token: 'a'.repeat(32), startedAt: Date.now(), version: '0.2.3' };

test('ui state round-trips and is written 0600', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmux-mcp-state-'));
  await writeUiState(dir, STATE);

  const read = await readUiState(dir);
  assert.equal(read.port, 7676);
  assert.equal(read.token, 'a'.repeat(32));

  assert.equal((await stat(stateFilePath(dir))).mode & 0o777, 0o600);

  await clearUiState(dir);
  assert.equal(await readUiState(dir), null);
});

test('unreadable or corrupt state reads as absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmux-mcp-state-'));
  assert.equal(await readUiState(dir), null);
  await writeFile(stateFilePath(dir), '{ not json');
  assert.equal(await readUiState(dir), null);
});

test('isProcessAlive tells this process from a dead one', () => {
  assert.equal(isProcessAlive(process.pid), true);
  // PID 0 is never a normal user process; kill(0, 0) addresses a process group.
  assert.equal(isProcessAlive(2_147_483_646), false);
});

test('newToken returns 32 hex characters, and differs each time', () => {
  const a = newToken();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, newToken());
});

test('only one of two concurrent spawners takes the lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmux-mcp-state-'));
  const [first, second] = await Promise.all([acquireSpawnLock(dir), acquireSpawnLock(dir)]);
  assert.equal([first, second].filter(Boolean).length, 1);

  await releaseSpawnLock(dir);
  assert.equal(await acquireSpawnLock(dir), true);
});

test('a stale lock is taken over', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmux-mcp-state-'));
  assert.equal(await acquireSpawnLock(dir), true);
  // Nothing released it, but it is older than the staleness window.
  assert.equal(await acquireSpawnLock(dir, -1), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/ui-state.test.mjs`
Expected: FAIL — `Cannot find module '../build/ui/state.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/state.ts`:

```typescript
import { randomBytes } from 'node:crypto';
import { open, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** What a running daemon advertises to anything that wants to reach it. */
export interface UiState {
  pid: number;
  port: number;
  token: string;
  startedAt: number;
  version: string;
}

const LOCK_STALE_MS = 30_000;

export function resolveStateDir(cliValue?: string): string {
  return cliValue ?? process.env.TMUX_MCP_STATE_DIR ?? join(homedir(), '.tmux-mcp');
}

export function stateFilePath(stateDir: string): string {
  return join(stateDir, 'ui.json');
}

function lockFilePath(stateDir: string): string {
  return join(stateDir, 'ui.lock');
}

async function ensureStateDir(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
}

export async function writeUiState(stateDir: string, state: UiState): Promise<void> {
  await ensureStateDir(stateDir);
  await writeFile(stateFilePath(stateDir), JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** Returns null when the file is missing, unreadable, or not valid state. */
export async function readUiState(stateDir: string): Promise<UiState | null> {
  try {
    const parsed = JSON.parse(await readFile(stateFilePath(stateDir), 'utf8')) as UiState;
    if (typeof parsed?.pid !== 'number' || typeof parsed?.port !== 'number' || typeof parsed?.token !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function clearUiState(stateDir: string): Promise<void> {
  await rm(stateFilePath(stateDir), { force: true });
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM means it exists but belongs to someone else.
    return error?.code === 'EPERM';
  }
}

export function newToken(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Exclusive lock so two MCP servers starting at the same moment do not both
 * spawn a daemon. 'wx' fails when the file exists, which makes the create
 * itself the atomic operation.
 */
export async function acquireSpawnLock(stateDir: string, staleMs: number = LOCK_STALE_MS): Promise<boolean> {
  await ensureStateDir(stateDir);
  const path = lockFilePath(stateDir);
  try {
    const handle = await open(path, 'wx', 0o600);
    await handle.writeFile(String(process.pid));
    await handle.close();
    return true;
  } catch {
    // Held by someone else — unless it was abandoned.
    try {
      const age = Date.now() - (await stat(path)).mtimeMs;
      if (age > staleMs) {
        await rm(path, { force: true });
        return acquireSpawnLock(stateDir, staleMs);
      }
    } catch {
      // Vanished between the failed create and the stat: let the caller retry.
    }
    return false;
  }
}

export async function releaseSpawnLock(stateDir: string): Promise<void> {
  await rm(lockFilePath(stateDir), { force: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/ui-state.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui/state.ts test/ui-state.test.mjs
git commit -m "feat: add dispatch service state file and spawn lock"
```

---

### Task 2: HTTP server skeleton with auth and health

The daemon that later tasks hang endpoints on. Nothing tmux-specific yet.

**Files:**
- Create: `src/ui/daemon.ts`
- Test: `test/ui-daemon.test.mjs`

**Interfaces:**
- Consumes: `UiState`, `writeUiState`, `newToken` (Task 1).
- Produces:
  - `interface DaemonOptions { stateDir: string; requestsDir: string; port?: number; token?: string; version?: string }`
  - `interface RunningDaemon { port: number; token: string; url: string; close(): Promise<void> }`
  - `startDaemon(options: DaemonOptions): Promise<RunningDaemon>`
  - `type Handler = (ctx: RouteContext) => Promise<unknown> | unknown`
  - `interface RouteContext { url: URL; params: Record<string, string>; body: unknown; req: IncomingMessage; res: ServerResponse }`
  - `registerRoute(method: string, pattern: string, handler: Handler): void` — pattern segments starting with `:` become params

- [ ] **Step 1: Write the failing test**

Create `test/ui-daemon.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { startDaemon } from '../build/ui/daemon.js';

async function withDaemon(run) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tmux-dispatch-'));
  const requestsDir = join(stateDir, 'requests');
  const daemon = await startDaemon({ stateDir, requestsDir, port: 0 });
  try {
    await run(daemon, { stateDir, requestsDir });
  } finally {
    await daemon.close();
  }
}

test('health needs no token and reports the pid', async () => {
  await withDaemon(async daemon => {
    const res = await fetch(`${daemon.url}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.pid, process.pid);
    assert.equal(typeof body.version, 'string');
  });
});

test('an unauthenticated api call is refused', async () => {
  await withDaemon(async daemon => {
    const res = await fetch(`${daemon.url}/api/requests`);
    assert.equal(res.status, 401);
  });
});

test('a wrong token is refused', async () => {
  await withDaemon(async daemon => {
    const res = await fetch(`${daemon.url}/api/requests`, {
      headers: { Authorization: 'Bearer wrong' },
    });
    assert.equal(res.status, 401);
  });
});

test('the right token is accepted', async () => {
  await withDaemon(async daemon => {
    const res = await fetch(`${daemon.url}/api/requests`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    assert.equal(res.status, 200);
  });
});

test('a foreign Host header is refused (DNS rebinding)', async () => {
  await withDaemon(async daemon => {
    const res = await fetch(`${daemon.url}/api/health`, {
      headers: { Host: 'evil.example.com' },
    });
    assert.equal(res.status, 403);
  });
});

test('a foreign Origin is refused', async () => {
  await withDaemon(async daemon => {
    const res = await fetch(`${daemon.url}/api/requests`, {
      headers: { Authorization: `Bearer ${daemon.token}`, Origin: 'http://evil.example.com' },
    });
    assert.equal(res.status, 403);
  });
});

test('the daemon writes its state file and removes it on close', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tmux-dispatch-'));
  const { readUiState } = await import('../build/ui/state.js');
  const daemon = await startDaemon({ stateDir, requestsDir: join(stateDir, 'requests'), port: 0 });
  const state = await readUiState(stateDir);
  assert.equal(state.port, daemon.port);
  assert.equal(state.token, daemon.token);
  assert.equal(state.pid, process.pid);

  await daemon.close();
  assert.equal(await readUiState(stateDir), null);
});

test('an unknown path is a 404 json error', async () => {
  await withDaemon(async daemon => {
    const res = await fetch(`${daemon.url}/api/nope`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /not found/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/ui-daemon.test.mjs`
Expected: FAIL — `Cannot find module '../build/ui/daemon.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/daemon.ts`:

```typescript
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { clearUiState, newToken, writeUiState } from './state.js';

export interface DaemonOptions {
  stateDir: string;
  requestsDir: string;
  /** 0 picks an ephemeral port. */
  port?: number;
  token?: string;
  version?: string;
}

export interface RunningDaemon {
  port: number;
  token: string;
  url: string;
  close(): Promise<void>;
}

export interface RouteContext {
  url: URL;
  params: Record<string, string>;
  body: unknown;
  req: IncomingMessage;
  res: ServerResponse;
  options: DaemonOptions;
}

export type Handler = (ctx: RouteContext) => Promise<unknown> | unknown;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

const routes: Route[] = [];

/** Register a route. Segments starting with ':' capture into ctx.params. */
export function registerRoute(method: string, pattern: string, handler: Handler): void {
  routes.push({
    method,
    segments: pattern.split('/').filter(Boolean),
    handler,
  });
}

/** Returned by a handler that has already written the response itself. */
export const HANDLED = Symbol('handled');

function matchRoute(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  const parts = pathname.split('/').filter(Boolean);
  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const seg = route.segments[i];
      if (seg.startsWith(':')) {
        params[seg.slice(1)] = decodeURIComponent(parts[i]);
      } else if (seg !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

/**
 * A loopback service is reachable by any page the browser loads, so a
 * hostname that resolves to 127.0.0.1 (DNS rebinding) would otherwise be
 * able to drive it. Requiring a literal loopback Host, and an Origin that
 * matches ours, closes that.
 */
function isLocalHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
    || host === '127.0.0.1' || host === 'localhost';
}

function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return true; // Same-origin fetches and curl send none.
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const token = options.token ?? newToken();
  const version = options.version ?? '0.2.3';

  const server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (!res.headersSent) sendJson(res, 500, { error: String(error) });
      else res.end();
    });
  });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const port = (server.address() as AddressInfo).port;
    if (!isLocalHost(req.headers.host, port) || !isAllowedOrigin(req.headers.origin, port)) {
      sendJson(res, 403, { error: 'forbidden host or origin' });
      return;
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, version, pid: process.pid });
      return;
    }

    const auth = req.headers.authorization;
    const presented = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : url.searchParams.get('t');
    if (presented !== token) {
      sendJson(res, 401, { error: 'missing or invalid token' });
      return;
    }

    const match = matchRoute(req.method ?? 'GET', url.pathname);
    if (!match) {
      sendJson(res, 404, { error: `not found: ${url.pathname}` });
      return;
    }

    const body = req.method === 'POST' || req.method === 'PATCH' ? await readBody(req) : undefined;
    const result = await match.route.handler({ url, params: match.params, body, req, res, options });
    if (result === HANDLED) return;
    sendJson(res, 200, result ?? { ok: true });
  };

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });

  const port = (server.address() as AddressInfo).port;
  await writeUiState(options.stateDir, {
    pid: process.pid,
    port,
    token,
    startedAt: Date.now(),
    version,
  });

  return {
    port,
    token,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await clearUiState(options.stateDir);
    },
  };
}
```

Register a placeholder requests route at the bottom of the file so the auth tests have something to hit; Task 3 replaces its body:

```typescript
registerRoute('GET', '/api/requests', () => ({ requests: [] }));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/ui-daemon.test.mjs`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui/daemon.ts test/ui-daemon.test.mjs
git commit -m "feat: add dispatch service daemon with token auth"
```

---

### Task 3: Request endpoints — list, live targets, grant, deny

The inbox itself. Targets are computed from live tmux state on every call, filtered by the scope recorded in the request file, so a pane opened after the request appears.

**Files:**
- Create: `src/ui/api-requests.ts`
- Modify: `src/ui/daemon.ts` (import the module so its routes register; drop the placeholder route)
- Modify: `src/cli-grant.ts` (export the live-target helper instead of keeping it private)
- Test: `test/ui-requests.test.mjs`

**Interfaces:**
- Consumes: `registerRoute`, `RouteContext` (Task 2); `listRequestFiles`, `readRequestFile`, `writeAnswerFile` from `src/requests-dir.js`; `PaneRequest` from `src/requests.js`.
- Produces:
  - `liveTargets(request: PaneRequest): Promise<Array<{ id: string; label: string }>>` exported from `src/cli-grant.ts`
  - routes `GET /api/requests`, `GET /api/requests/:id/targets`, `POST /api/requests/:id/grant`, `POST /api/requests/:id/deny`

- [ ] **Step 1: Write the failing test**

Create `test/ui-requests.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { startDaemon } from '../build/ui/daemon.js';
import { executeTmux } from '../build/tmux.js';

async function withInbox(run) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tmux-dispatch-'));
  const requestsDir = join(stateDir, 'requests');
  await mkdir(requestsDir, { recursive: true, mode: 0o700 });
  const daemon = await startDaemon({ stateDir, requestsDir, port: 0 });
  const api = (path, init = {}) => fetch(`${daemon.url}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  try {
    await run({ api, requestsDir });
  } finally {
    await daemon.close();
  }
}

async function writeRequest(requestsDir, overrides = {}) {
  const id = `r-${randomUUID().slice(0, 8)}`;
  await writeFile(join(requestsDir, `${id}.json`), JSON.stringify({
    id,
    reason: 'run the test suite',
    kind: 'pane',
    createdAt: Date.now(),
    candidates: [],
    scope: { mode: 'none', sessionIds: [], windowId: null, excludedPaneId: null },
    ...overrides,
  }), { mode: 0o600 });
  return id;
}

test('pending requests are listed with their reason and age', async () => {
  await withInbox(async ({ api, requestsDir }) => {
    const id = await writeRequest(requestsDir);
    const body = await (await api('/api/requests')).json();
    const found = body.requests.find(r => r.id === id);
    assert.equal(found.reason, 'run the test suite');
    assert.equal(found.kind, 'pane');
    assert.ok(Number.isFinite(found.ageSeconds));
  });
});

test('targets are computed live, so a pane opened after the request shows up', async () => {
  const sessionName = `tmux-dispatch-${process.pid}-${randomUUID()}`;
  await withInbox(async ({ api, requestsDir }) => {
    const id = await writeRequest(requestsDir);
    const paneId = await executeTmux(['new-session', '-d', '-s', sessionName, '-P', '-F', '#{pane_id}']);
    try {
      const body = await (await api(`/api/requests/${id}/targets`)).json();
      assert.ok(body.targets.some(t => t.id === paneId));
      assert.ok(body.targets.every(t => typeof t.label === 'string'));
    } finally {
      await executeTmux(['kill-session', '-t', sessionName]);
    }
  });
});

test('a target outside the recorded scope is not offered and cannot be granted', async () => {
  const sessionName = `tmux-dispatch-${process.pid}-${randomUUID()}`;
  await withInbox(async ({ api, requestsDir }) => {
    const id = await writeRequest(requestsDir, {
      scope: { mode: 'window', sessionIds: [], windowId: '@999999', excludedPaneId: null },
    });
    const paneId = await executeTmux(['new-session', '-d', '-s', sessionName, '-P', '-F', '#{pane_id}']);
    try {
      const targets = (await (await api(`/api/requests/${id}/targets`)).json()).targets;
      assert.ok(!targets.some(t => t.id === paneId));

      const res = await api(`/api/requests/${id}/grant`, {
        method: 'POST',
        body: JSON.stringify({ target: paneId }),
      });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /cannot be assigned/i);
    } finally {
      await executeTmux(['kill-session', '-t', sessionName]);
    }
  });
});

test('granting writes the answer file the MCP server watches for', async () => {
  const sessionName = `tmux-dispatch-${process.pid}-${randomUUID()}`;
  await withInbox(async ({ api, requestsDir }) => {
    const id = await writeRequest(requestsDir);
    const paneId = await executeTmux(['new-session', '-d', '-s', sessionName, '-P', '-F', '#{pane_id}']);
    try {
      const res = await api(`/api/requests/${id}/grant`, {
        method: 'POST',
        body: JSON.stringify({ target: paneId }),
      });
      assert.equal(res.status, 200);
      assert.equal((await readFile(join(requestsDir, `${id}.grant`), 'utf8')).trim(), paneId);
    } finally {
      await executeTmux(['kill-session', '-t', sessionName]);
    }
  });
});

test('denying writes a deny file with the reason', async () => {
  await withInbox(async ({ api, requestsDir }) => {
    const id = await writeRequest(requestsDir);
    const res = await api(`/api/requests/${id}/deny`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'not now' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await readFile(join(requestsDir, `${id}.deny`), 'utf8')).trim(), 'not now');
  });
});

test('an unknown request id is a 404', async () => {
  await withInbox(async ({ api }) => {
    const res = await api('/api/requests/r-nope/grant', {
      method: 'POST',
      body: JSON.stringify({ target: '%1' }),
    });
    assert.equal(res.status, 404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/ui-requests.test.mjs`
Expected: FAIL — `/api/requests` returns the placeholder `{ requests: [] }`, so the first test fails on `found` being undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/cli-grant.ts`, change `async function liveTargets(` to `export async function liveTargets(` so the daemon reuses exactly the filter the CLI applies. Leave its body unchanged.

Create `src/ui/api-requests.ts`:

```typescript
import { registerRoute, type RouteContext } from './daemon.js';
import { listRequestFiles, readRequestFile, writeAnswerFile } from '../requests-dir.js';
import { liveTargets } from '../cli-grant.js';

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function loadRequest(ctx: RouteContext) {
  const request = await readRequestFile(ctx.options.requestsDir, ctx.params.id);
  if (!request) throw new HttpError(404, `no pending request ${ctx.params.id}`);
  return request;
}

registerRoute('GET', '/api/requests', async ctx => {
  const requests = await listRequestFiles(ctx.options.requestsDir);
  return {
    requests: requests
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(request => ({
        id: request.id,
        reason: request.reason,
        kind: request.kind,
        createdAt: request.createdAt,
        ageSeconds: Math.round((Date.now() - request.createdAt) / 1000),
      })),
  };
});

// Computed on every call, never cached: the whole point is that a pane the
// human opens after reading the request is assignable.
registerRoute('GET', '/api/requests/:id/targets', async ctx => {
  const request = await loadRequest(ctx);
  return { targets: await liveTargets(request) };
});

registerRoute('POST', '/api/requests/:id/grant', async ctx => {
  const request = await loadRequest(ctx);
  const target = (ctx.body as { target?: unknown } | undefined)?.target;
  if (typeof target !== 'string' || target.length === 0) {
    throw new HttpError(400, 'target is required');
  }
  const targets = await liveTargets(request);
  if (!targets.some(candidate => candidate.id === target)) {
    throw new HttpError(400, `${target} cannot be assigned: it does not exist now, or it is outside the request's scope`);
  }
  await writeAnswerFile(ctx.options.requestsDir, request.id, 'grant', target);
  return { ok: true, target };
});

registerRoute('POST', '/api/requests/:id/deny', async ctx => {
  const request = await loadRequest(ctx);
  const reason = (ctx.body as { reason?: unknown } | undefined)?.reason;
  await writeAnswerFile(ctx.options.requestsDir, request.id, 'deny', typeof reason === 'string' ? reason : '');
  return { ok: true };
});

export { HttpError };
```

In `src/ui/daemon.ts`, delete the placeholder `registerRoute('GET', '/api/requests', …)` line and import the module for its side effects, at the top of the file:

```typescript
import './api-requests.js';
```

That import is circular (`api-requests` imports `registerRoute` from `daemon`). ESM handles it because `registerRoute` and `routes` are evaluated before the import runs only if the import sits *after* their declarations — so put this import at the **bottom** of `daemon.ts` instead, with a comment:

```typescript
// Imported for side effects: route modules call registerRoute() at load time.
// Must be last, so registerRoute and the routes array already exist.
await import('./api-requests.js');
```

Since a top-level `await import` makes the module async, use it inside `startDaemon` instead:

```typescript
export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  // Route modules register on first load; importing here keeps the module
  // graph acyclic at evaluation time.
  await import('./api-requests.js');
  ...
```

Teach the error handler about `HttpError` — in the `catch` inside `createServer`:

```typescript
    void handle(req, res).catch(error => {
      const status = typeof error?.status === 'number' ? error.status : 500;
      if (!res.headersSent) sendJson(res, status, { error: error?.message ?? String(error) });
      else res.end();
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/ui-requests.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui/api-requests.ts src/ui/daemon.ts src/cli-grant.ts test/ui-requests.test.mjs
git commit -m "feat: serve pane requests and live targets from the dispatch service"
```

---

### Task 4: Server-sent events for new and answered requests

So an open page shows a request the moment it arrives, without polling.

**Files:**
- Create: `src/ui/events.ts`
- Modify: `src/ui/daemon.ts` (load the module; keep the SSE response open)
- Test: `test/ui-events.test.mjs`

**Interfaces:**
- Consumes: `registerRoute`, `HANDLED` (Task 2); `listRequestFiles` from `src/requests-dir.js`.
- Produces:
  - `startRequestsWatcher(requestsDir: string, emit: (event: string, data: unknown) => void): () => void`
  - route `GET /events`

- [ ] **Step 1: Write the failing test**

Create `test/ui-events.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { startDaemon } from '../build/ui/daemon.js';

test('an arriving request is pushed to a connected client', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tmux-dispatch-'));
  const requestsDir = join(stateDir, 'requests');
  await mkdir(requestsDir, { recursive: true, mode: 0o700 });
  const daemon = await startDaemon({ stateDir, requestsDir, port: 0 });

  const controller = new AbortController();
  try {
    const res = await fetch(`${daemon.url}/events`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const id = `r-${randomUUID().slice(0, 8)}`;

    // Write the request only after the stream is open.
    setTimeout(() => {
      void writeFile(join(requestsDir, `${id}.json`), JSON.stringify({
        id, reason: 'look at me', kind: 'pane', createdAt: Date.now(),
        candidates: [], scope: { mode: 'none', sessionIds: [], windowId: null, excludedPaneId: null },
      }), { mode: 0o600 });
    }, 100);

    let buffer = '';
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !buffer.includes('request-added')) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }

    assert.match(buffer, /event: request-added/);
    assert.match(buffer, /look at me/);
  } finally {
    controller.abort();
    await daemon.close();
  }
});

test('the event stream needs a token', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tmux-dispatch-'));
  const daemon = await startDaemon({ stateDir, requestsDir: join(stateDir, 'requests'), port: 0 });
  try {
    const res = await fetch(`${daemon.url}/events`);
    assert.equal(res.status, 401);
  } finally {
    await daemon.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/ui-events.test.mjs`
Expected: FAIL — `/events` returns 404.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/events.ts`:

```typescript
import { watch } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { HANDLED, registerRoute } from './daemon.js';
import { listRequestFiles } from '../requests-dir.js';

const POLL_INTERVAL_MS = 1000;

interface Subscriber {
  res: ServerResponse;
}

const subscribers = new Set<Subscriber>();

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const sub of subscribers) {
    try { sub.res.write(payload); } catch { /* the reaper below removes it */ }
  }
}

/**
 * Watch the requests directory and emit request-added / request-answered.
 * fs.watch is unreliable on some filesystems, so it only nudges a scan that
 * a timer would run anyway.
 */
export function startRequestsWatcher(
  requestsDir: string,
  emit: (event: string, data: unknown) => void
): () => void {
  let known = new Set<string>();
  let primed = false;

  const scan = async (): Promise<void> => {
    const requests = await listRequestFiles(requestsDir);
    const current = new Set(requests.map(r => r.id));

    if (!primed) {
      known = current;
      primed = true;
      return;
    }
    for (const request of requests) {
      if (!known.has(request.id)) {
        emit('request-added', {
          id: request.id,
          reason: request.reason,
          kind: request.kind,
          createdAt: request.createdAt,
        });
      }
    }
    for (const id of known) {
      if (!current.has(id)) emit('request-answered', { id });
    }
    known = current;
  };

  void scan();

  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(requestsDir, () => { void scan(); });
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

registerRoute('GET', '/events', ctx => {
  ctx.res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  ctx.res.write(': connected\n\n');

  const sub: Subscriber = { res: ctx.res };
  subscribers.add(sub);
  ctx.req.on('close', () => { subscribers.delete(sub); });

  return HANDLED;
});

export { broadcast };
```

In `src/ui/daemon.ts`, inside `startDaemon`, load the events module alongside the requests module and start the watcher, keeping its stop function for `close()`:

```typescript
  await import('./api-requests.js');
  const { startRequestsWatcher, broadcast } = await import('./events.js');
  const stopWatcher = startRequestsWatcher(options.requestsDir, broadcast);
```

and in the returned `close`:

```typescript
    close: async () => {
      stopWatcher();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await clearUiState(options.stateDir);
    },
```

`server.close()` waits for open connections, and an SSE stream never ends on
its own, so destroy them first — add this just above the `server.close` call:

```typescript
      for (const socket of openSockets) socket.destroy();
```

and track sockets where the server is created:

```typescript
  const openSockets = new Set<import('node:net').Socket>();
  server.on('connection', socket => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/ui-events.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui/events.ts src/ui/daemon.ts test/ui-events.test.mjs
git commit -m "feat: push request events over SSE"
```

---

### Task 5: The `ui` subcommand — run, detached, print-url, stop

**Files:**
- Create: `src/cli-ui.ts`
- Modify: `src/index.ts` (extend the subcommand dispatch added for `grant`)
- Test: `test/ui-cli.test.mjs`

**Interfaces:**
- Consumes: `startDaemon` (Task 2); `resolveStateDir`, `readUiState`, `isProcessAlive`, `clearUiState` (Task 1); `resolveRequestsDir` from `src/requests-dir.js`.
- Produces:
  - `isUiCliCommand(value: string | undefined): value is 'ui'`
  - `runUiCli(argv: string[]): Promise<number>`
  - `probeDaemon(state: UiState): Promise<boolean>` — pid alive **and** `/api/health` answers
  - `ensureDaemonRunning(stateDir: string, requestsDir: string): Promise<UiState | null>`

- [ ] **Step 1: Write the failing test**

Create `test/ui-cli.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { readUiState, writeUiState } from '../build/ui/state.js';
import { ensureDaemonRunning, probeDaemon } from '../build/cli-ui.js';

const run = promisify(execFile);

test('print-url reports nothing when no daemon runs', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tmux-dispatch-'));
  const { stdout } = await run(process.execPath, [
    'build/index.js', 'ui', '--print-url', `--state-dir=${stateDir}`,
  ], { cwd: process.cwd() });
  assert.match(stdout, /not running/i);
});

test('a state file with a dead pid does not count as running', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tmux-dispatch-'));
  await writeUiState(stateDir, {
    pid: 2_147_483_646, port: 1, token: 'x'.repeat(32), startedAt: Date.now(), version: '0.0.0',
  });
  assert.equal(await probeDaemon(await readUiState(stateDir)), false);
});

test('ensureDaemonRunning spawns one daemon, and reuses it afterwards', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tmux-dispatch-'));
  const requestsDir = join(stateDir, 'requests');

  const first = await ensureDaemonRunning(stateDir, requestsDir);
  assert.ok(first, 'a daemon should have been spawned');
  try {
    assert.equal(await probeDaemon(first), true);

    const second = await ensureDaemonRunning(stateDir, requestsDir);
    assert.equal(second.pid, first.pid, 'the running daemon should be reused');

    const { stdout } = await run(process.execPath, [
      'build/index.js', 'ui', '--print-url', `--state-dir=${stateDir}`,
    ], { cwd: process.cwd() });
    assert.match(stdout, new RegExp(`http://127\\.0\\.0\\.1:${first.port}/\\?t=`));
  } finally {
    await run(process.execPath, ['build/index.js', 'ui', '--stop', `--state-dir=${stateDir}`], { cwd: process.cwd() });
  }

  assert.equal(await readUiState(stateDir), null);
});

test('two concurrent ensureDaemonRunning calls produce one daemon', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tmux-dispatch-'));
  const requestsDir = join(stateDir, 'requests');
  try {
    const [a, b] = await Promise.all([
      ensureDaemonRunning(stateDir, requestsDir),
      ensureDaemonRunning(stateDir, requestsDir),
    ]);
    assert.ok(a && b);
    assert.equal(a.pid, b.pid);
  } finally {
    await run(process.execPath, ['build/index.js', 'ui', '--stop', `--state-dir=${stateDir}`], { cwd: process.cwd() });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/ui-cli.test.mjs`
Expected: FAIL — `Cannot find module '../build/cli-ui.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/cli-ui.ts`:

```typescript
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { startDaemon } from './ui/daemon.js';
import {
  acquireSpawnLock,
  clearUiState,
  isProcessAlive,
  readUiState,
  releaseSpawnLock,
  resolveStateDir,
  type UiState,
} from './ui/state.js';
import { resolveRequestsDir } from './requests-dir.js';

export function isUiCliCommand(value: string | undefined): value is 'ui' {
  return value === 'ui';
}

/** Alive means: the process exists AND the port answers as one of ours. */
export async function probeDaemon(state: UiState | null): Promise<boolean> {
  if (!state || !isProcessAlive(state.pid)) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/api/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return false;
    const body = await res.json() as { ok?: boolean; pid?: number };
    return body.ok === true && body.pid === state.pid;
  } catch {
    return false;
  }
}

function daemonUrl(state: UiState): string {
  return `http://127.0.0.1:${state.port}/?t=${state.token}`;
}

async function waitForState(stateDir: string, timeoutMs: number): Promise<UiState | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readUiState(stateDir);
    if (await probeDaemon(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
}

/**
 * Make sure exactly one daemon is running, spawning it if needed. Returns the
 * live state, or null when it could not be started — never throws, because a
 * missing dispatch must not stop an MCP server from serving.
 */
export async function ensureDaemonRunning(stateDir: string, requestsDir: string): Promise<UiState | null> {
  const existing = await readUiState(stateDir);
  if (await probeDaemon(existing)) return existing;

  // Stale file: the daemon died without cleaning up.
  if (existing) await clearUiState(stateDir);

  if (!(await acquireSpawnLock(stateDir))) {
    // Someone else is spawning right now; wait for their daemon.
    return waitForState(stateDir, 3000);
  }
  try {
    const child = spawn(process.execPath, [
      process.argv[1], 'ui', '--detached', `--state-dir=${stateDir}`, `--requests-dir=${requestsDir}`,
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    return await waitForState(stateDir, 5000);
  } catch {
    return null;
  } finally {
    await releaseSpawnLock(stateDir);
  }
}

export async function runUiCli(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      'state-dir': { type: 'string' },
      'requests-dir': { type: 'string' },
      port: { type: 'string' },
      detached: { type: 'boolean', default: false },
      'print-url': { type: 'boolean', default: false },
      stop: { type: 'boolean', default: false },
    },
  });

  const stateDir = resolveStateDir(values['state-dir'] as string | undefined);
  const requestsDir = resolveRequestsDir(values['requests-dir'] as string | undefined);
  const state = await readUiState(stateDir);

  if (values['print-url']) {
    if (await probeDaemon(state)) {
      console.log(daemonUrl(state!));
      return 0;
    }
    console.log('The dispatch service is not running. Start it with: tmux-mcp ui');
    return 1;
  }

  if (values.stop) {
    if (!state) {
      console.log('The dispatch service is not running.');
      return 0;
    }
    try { process.kill(state.pid, 'SIGTERM'); } catch { /* already gone */ }
    // The daemon clears its own state on SIGTERM; clean up if it could not.
    for (let i = 0; i < 40 && (await readUiState(stateDir)); i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await clearUiState(stateDir);
    console.log('Stopped the dispatch service.');
    return 0;
  }

  if (await probeDaemon(state)) {
    console.log(`Already running: ${daemonUrl(state!)}`);
    return 0;
  }
  if (state) await clearUiState(stateDir);

  const portRaw = (values.port as string | undefined) ?? process.env.TMUX_MCP_DISPATCH_PORT;
  const port = portRaw === undefined ? 7676 : Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid --port: '${portRaw}'.`);
    return 1;
  }

  let daemon;
  try {
    daemon = await startDaemon({ stateDir, requestsDir, port });
  } catch {
    // The preferred port is taken by something that is not us.
    daemon = await startDaemon({ stateDir, requestsDir, port: 0 });
  }

  const shutdown = () => { void daemon.close().then(() => process.exit(0)); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  if (!values.detached) {
    console.log(`Dispatch: http://127.0.0.1:${daemon.port}/?t=${daemon.token}`);
    console.log('Stop it with: tmux-mcp ui --stop');
  }
  // Resolve only when the daemon stops, so the foreground command blocks.
  await new Promise(() => { /* runs until a signal arrives */ });
  return 0;
}
```

In `src/index.ts`, extend the existing subcommand dispatch at the top of `main()`:

```typescript
    const subcommand = process.argv[2];
    if (isGrantCliCommand(subcommand)) {
      process.exit(await runGrantCli(process.argv.slice(2)));
    }
    if (isUiCliCommand(subcommand)) {
      process.exit(await runUiCli(process.argv.slice(2)));
    }
```

and add the import:

```typescript
import { isUiCliCommand, runUiCli, ensureDaemonRunning } from './cli-ui.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/ui-cli.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli-ui.ts src/index.ts test/ui-cli.test.mjs
git commit -m "feat: add the tmux-mcp ui subcommand"
```

---

### Task 6: The page

One HTML file, one stylesheet, one ES module. No framework, no build step beyond copying the files into `build/`.

**Files:**
- Create: `src/ui/public/index.html`, `src/ui/public/app.css`, `src/ui/public/app.js`
- Create: `src/ui/static.ts`
- Modify: `package.json` (build script copies the assets)
- Modify: `src/ui/daemon.ts` (load the static module)
- Test: `test/ui-page.test.mjs`

**Interfaces:**
- Consumes: `registerRoute`, `HANDLED` (Task 2).
- Produces: routes `GET /`, `GET /r/:id`, `GET /app.css`, `GET /app.js`.

- [ ] **Step 1: Write the failing test**

Create `test/ui-page.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { startDaemon } from '../build/ui/daemon.js';

async function withDaemon(run) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tmux-dispatch-'));
  const daemon = await startDaemon({ stateDir, requestsDir: join(stateDir, 'requests'), port: 0 });
  try {
    await run(daemon);
  } finally {
    await daemon.close();
  }
}

test('the page is served, and carries the token from the query string', async () => {
  await withDaemon(async daemon => {
    const res = await fetch(`${daemon.url}/?t=${daemon.token}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
    assert.match(html, /app\.css/);
  });
});

test('a deep link to one request serves the same page', async () => {
  await withDaemon(async daemon => {
    const res = await fetch(`${daemon.url}/r/r-abc123?t=${daemon.token}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
  });
});

test('the page assets are served with the right content types', async () => {
  await withDaemon(async daemon => {
    const css = await fetch(`${daemon.url}/app.css?t=${daemon.token}`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    const js = await fetch(`${daemon.url}/app.js?t=${daemon.token}`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
  });
});

test('the page is refused without a token', async () => {
  await withDaemon(async daemon => {
    assert.equal((await fetch(`${daemon.url}/`)).status, 401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/ui-page.test.mjs`
Expected: FAIL — `/` returns 404.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/public/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>tmux-mcp</title>
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body>
    <header>
      <h1>tmux-mcp</h1>
      <p id="status">Connecting…</p>
    </header>
    <main>
      <section id="requests">
        <h2>Pending requests</h2>
        <p class="empty">Nothing is waiting.</p>
      </section>
    </main>
    <script type="module" src="/app.js"></script>
  </body>
</html>
```

Create `src/ui/public/app.css`:

```css
:root { color-scheme: light dark; --gap: 0.75rem; }
body {
  margin: 0;
  font: 15px/1.5 ui-sans-serif, system-ui, sans-serif;
  padding: var(--gap);
}
header { display: flex; align-items: baseline; gap: var(--gap); }
h1 { font-size: 1.1rem; margin: 0; }
h2 { font-size: 0.95rem; margin: 1.25rem 0 0.5rem; }
#status { margin: 0; opacity: 0.7; font-size: 0.85rem; }
.request {
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 6px;
  padding: var(--gap);
  margin-bottom: var(--gap);
}
.reason { font-weight: 600; }
.age { opacity: 0.7; font-size: 0.85rem; }
.targets { list-style: none; margin: 0.5rem 0 0; padding: 0; }
.targets li { display: flex; align-items: center; gap: 0.5rem; padding: 2px 0; }
.targets code { font: 13px/1.4 ui-monospace, monospace; }
button { font: inherit; padding: 2px 10px; border-radius: 5px; cursor: pointer; }
.empty { opacity: 0.7; }
.error { color: #b00020; }
```

Create `src/ui/public/app.js`:

```javascript
// The token arrives once in the query string and then lives in sessionStorage,
// so refreshing or following a deep link keeps working without it in the URL.
const params = new URLSearchParams(location.search);
const fromUrl = params.get('t');
if (fromUrl) {
  sessionStorage.setItem('tmux-mcp-token', fromUrl);
  params.delete('t');
  history.replaceState({}, '', location.pathname + (params.toString() ? `?${params}` : ''));
}
const token = sessionStorage.getItem('tmux-mcp-token') ?? '';

const status = document.getElementById('status');
const list = document.getElementById('requests');

async function api(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}

function ageLabel(seconds) {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

async function renderTargets(request, container) {
  container.textContent = 'Loading…';
  try {
    const { targets } = await api(`/api/requests/${request.id}/targets`);
    container.replaceChildren();
    if (targets.length === 0) {
      container.append(Object.assign(document.createElement('p'), {
        className: 'empty',
        textContent: `No ${request.kind} can be assigned right now.`,
      }));
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'targets';
    for (const target of targets) {
      const li = document.createElement('li');
      const assign = Object.assign(document.createElement('button'), { textContent: 'Assign' });
      assign.addEventListener('click', async () => {
        assign.disabled = true;
        try {
          await api(`/api/requests/${request.id}/grant`, {
            method: 'POST',
            body: JSON.stringify({ target: target.id }),
          });
          void refresh();
        } catch (error) {
          assign.disabled = false;
          status.textContent = error.message;
          status.className = 'error';
        }
      });
      const code = Object.assign(document.createElement('code'), { textContent: target.label });
      li.append(assign, code);
      ul.append(li);
    }
    container.replaceChildren(ul);
  } catch (error) {
    container.textContent = error.message;
    container.className = 'error';
  }
}

function renderRequest(request) {
  const card = document.createElement('article');
  card.className = 'request';
  card.id = `request-${request.id}`;

  const head = document.createElement('p');
  head.append(
    Object.assign(document.createElement('span'), { className: 'reason', textContent: request.reason }),
    ' ',
    Object.assign(document.createElement('span'), { className: 'age', textContent: ageLabel(request.ageSeconds) }),
  );

  const targets = document.createElement('div');

  const refreshBtn = Object.assign(document.createElement('button'), { textContent: 'Refresh list' });
  // The list is a live view: a pane opened just now appears after this.
  refreshBtn.addEventListener('click', () => void renderTargets(request, targets));

  const denyBtn = Object.assign(document.createElement('button'), { textContent: 'Deny' });
  denyBtn.addEventListener('click', async () => {
    denyBtn.disabled = true;
    try {
      await api(`/api/requests/${request.id}/deny`, {
        method: 'POST',
        body: JSON.stringify({ reason: '' }),
      });
      void refresh();
    } catch (error) {
      denyBtn.disabled = false;
      status.textContent = error.message;
    }
  });

  card.append(head, refreshBtn, ' ', denyBtn, targets);
  void renderTargets(request, targets);
  return card;
}

async function refresh() {
  try {
    const { requests } = await api('/api/requests');
    list.replaceChildren(Object.assign(document.createElement('h2'), { textContent: 'Pending requests' }));
    if (requests.length === 0) {
      list.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'Nothing is waiting.' }));
    } else {
      for (const request of requests) list.append(renderRequest(request));
    }
    status.textContent = `${requests.length} pending`;
    status.className = '';

    const deep = location.pathname.match(/^\/r\/(.+)$/);
    if (deep) document.getElementById(`request-${deep[1]}`)?.scrollIntoView();
  } catch (error) {
    status.textContent = error.message;
    status.className = 'error';
  }
}

const events = new EventSource(`/events?t=${encodeURIComponent(token)}`);
events.addEventListener('request-added', event => {
  void refresh();
  const data = JSON.parse(event.data);
  if (Notification?.permission === 'granted') {
    new Notification('tmux-mcp: an agent wants a pane', { body: data.reason });
  }
});
events.addEventListener('request-answered', () => void refresh());

if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
  void Notification.requestPermission();
}

void refresh();
```

Create `src/ui/static.ts`:

```typescript
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HANDLED, registerRoute } from './daemon.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

async function serve(file: string, res: import('node:http').ServerResponse): Promise<typeof HANDLED> {
  const ext = file.slice(file.lastIndexOf('.'));
  const body = await readFile(join(publicDir, file));
  res.writeHead(200, {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
  });
  res.end(body);
  return HANDLED;
}

registerRoute('GET', '/', ctx => serve('index.html', ctx.res));
// Deep link from a notification: same page, scrolled to one request.
registerRoute('GET', '/r/:id', ctx => serve('index.html', ctx.res));
registerRoute('GET', '/app.css', ctx => serve('app.css', ctx.res));
registerRoute('GET', '/app.js', ctx => serve('app.js', ctx.res));
```

Load it in `startDaemon`, next to the other route modules:

```typescript
  await import('./api-requests.js');
  await import('./static.js');
```

In `package.json`, make the build copy the assets:

```json
    "build": "tsc && npm run copy-ui",
    "copy-ui": "mkdir -p build/ui/public && cp src/ui/public/* build/ui/public/",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/ui-page.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui/public src/ui/static.ts src/ui/daemon.ts package.json test/ui-page.test.mjs
git commit -m "feat: serve the dispatch service page"
```

---

### Task 7: Remove elicitation, wire `--ui`, notify with the request URL

The MCP-side change: no in-client prompting at all, the daemon started on demand, and every notification carrying the deep link.

**Files:**
- Delete: `src/elicit-channel.ts`, `test/elicit-channel.test.mjs`
- Modify: `src/index.ts` (drop elicitation, add `--ui`, put the URL in notifications)
- Modify: `src/assign-hook.ts` (`dispatchUrl` in the payload)
- Test: `test/human-assigned.test.mjs` (extend), `test/assign-hook.test.mjs` (extend)

**Interfaces:**
- Consumes: `ensureDaemonRunning`, `probeDaemon` (Task 5); `readUiState`, `resolveStateDir` (Task 1).
- Produces: `requestUrl(state: UiState | null, requestId: string): string | undefined` in `src/index.ts`.

- [ ] **Step 1: Write the failing test**

Append to `test/human-assigned.test.mjs`:

```javascript
test('no elicitation is sent, even to a client that supports it', async () => {
  const { ElicitRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const sessionName = `tmux-mcp-ha-${process.pid}-${randomUUID()}`;
  const paneId = await executeTmux(['new-session', '-d', '-s', sessionName, '-P', '-F', '#{pane_id}']);
  const requestsDir = await mkdtemp(join(tmpdir(), 'tmux-mcp-ha-'));

  const client = new Client(
    { name: 'elicit-capable-test', version: '1.0.0' },
    { capabilities: { elicitation: {} } }
  );
  const seen = [];
  client.setRequestHandler(ElicitRequestSchema, request => {
    seen.push(request.params);
    return { action: 'accept', content: { target: paneId } };
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js', '--human-assigned', `--requests-dir=${requestsDir}`],
    cwd: process.cwd(),
    stderr: 'pipe',
  });

  try {
    await client.connect(transport);
    const first = await client.callTool({
      name: 'request-pane',
      arguments: { reason: 'run the linter', timeoutSeconds: 2 },
    });
    // The request must wait for a human, not be answered by the client.
    assert.match(resultText(first), /^Status: pending$/m);
    assert.equal(seen.length, 0);
  } finally {
    await transport.close();
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});

test('--ui starts a daemon and puts its request URL in the log notification', async () => {
  const sessionName = `tmux-mcp-ha-${process.pid}-${randomUUID()}`;
  await executeTmux(['new-session', '-d', '-s', sessionName]);
  const stateDir = await mkdtemp(join(tmpdir(), 'tmux-dispatch-'));
  const requestsDir = join(stateDir, 'requests');

  const client = new Client({ name: 'ui-flag-test', version: '1.0.0' }, { capabilities: { logging: {} } });
  const logs = [];
  const { LoggingMessageNotificationSchema } = await import('@modelcontextprotocol/sdk/types.js');
  client.setNotificationHandler(LoggingMessageNotificationSchema, note => { logs.push(String(note.params.data)); });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js', '--human-assigned', '--ui', `--requests-dir=${requestsDir}`, `--state-dir=${stateDir}`],
    cwd: process.cwd(),
    stderr: 'pipe',
  });

  try {
    await client.connect(transport);
    await client.callTool({ name: 'request-pane', arguments: { reason: 'look at dispatch', timeoutSeconds: 2 } });
    assert.ok(
      logs.some(line => /http:\/\/127\.0\.0\.1:\d+\/r\/r-[a-z0-9]+/.test(line)),
      `expected a request URL in the log notifications, got: ${JSON.stringify(logs)}`
    );
  } finally {
    await transport.close();
    await execFileAsync(process.execPath, ['build/index.js', 'ui', '--stop', `--state-dir=${stateDir}`], { cwd: process.cwd() });
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});
```

Add near the other imports in that file:

```javascript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
```

Append to `test/assign-hook.test.mjs`:

```javascript
test('the hook payload carries the dispatch url when one is given', async () => {
  const path = await hookScript('cat | grep -q "http://127.0.0.1:7676/r/r-abc123" && echo "%3"');
  const answer = await new Promise(resolve => {
    const kill = spawnAssignHook(path, REQUEST, '/tmp', a => resolve(a), () => {}, 'http://127.0.0.1:7676/r/r-abc123');
    setTimeout(() => { kill(); resolve(null); }, 3000);
  });
  assert.deepEqual(answer, { status: 'granted', target: '%3', via: 'hook' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/human-assigned.test.mjs test/assign-hook.test.mjs`
Expected: FAIL — the elicit-capable client still receives an elicitation, `--ui` is an unknown option, and `spawnAssignHook` ignores the sixth argument.

- [ ] **Step 3: Write minimal implementation**

Delete the elicitation channel:

```bash
git rm src/elicit-channel.ts test/elicit-channel.test.mjs
```

In `src/index.ts`:

Remove the import line `import { clientSupportsElicitation, startElicitation } from './elicit-channel.js';` and the whole elicitation block inside the `request-pane` handler:

```typescript
          if (clientSupportsElicitation(server.server)) {
            cleanups.push(startElicitation(server.server, created, answer => {
              void answerRequest(created.id, answer);
            }, logToClient));
          }
```

Add dispatch flag next to the other module-load peeks (after `humanAssigned`):

```typescript
// Whether to run the local dispatch service. Peeked at module load so the
// request-pane description can mention it.
const uiEnabled: boolean = (() => {
  const argv = process.argv.slice(2);
  if (argv.includes('--ui')) return true;
  const env = process.env.TMUX_MCP_DISPATCH;
  return env === '1' || env === 'true';
})();
```

Add module state and a helper next to `requestsDir`:

```typescript
let uiState: import('./ui/state.js').UiState | null = null;

/** Deep link to one request in the dispatch service, when it is running. */
function requestUrl(requestId: string): string | undefined {
  if (!uiState) return undefined;
  return `http://127.0.0.1:${uiState.port}/r/${requestId}?t=${uiState.token}`;
}
```

Extend `parseArgs` options with `'ui': { type: 'boolean', default: false }` and `'state-dir': { type: 'string' }`, and in `main()` after `requestsDir` is resolved:

```typescript
    if (humanAssigned && uiEnabled) {
      const stateDir = resolveStateDir(values['state-dir'] as string | undefined);
      // Never fatal: without dispatch, the grant CLI still answers requests.
      uiState = await ensureDaemonRunning(stateDir, requestsDir);
      if (!uiState) console.error('[tmux-mcp] could not start the dispatch service; use `tmux-mcp grant` instead');
    }
```

with the import:

```typescript
import { resolveStateDir } from './ui/state.js';
```

Put the URL into both notifications — replace `notifyAttachedClients` and the log line:

```typescript
async function notifyAttachedClients(request: PaneRequest): Promise<void> {
  const url = requestUrl(request.id);
  const how = url ?? `tmux-mcp grant ${request.id} <target>`;
  try {
    await tmux.executeTmux([
      'display-message', '-a',
      `tmux-mcp: agent requests a ${request.kind} (${request.reason}) - ${how}`,
    ]);
  } catch {
    // No tmux server or no attached client: the other channels still work.
  }
}
```

and where the request is created:

```typescript
          const url = requestUrl(request.id);
          logToClient('info', `pane request ${request.id}: ${reason}${url ? ` — ${url}` : ''}`);
```

In `src/assign-hook.ts`, take the URL and pass it through:

```typescript
export function spawnAssignHook(
  hookPath: string,
  request: PaneRequest,
  requestsDir: string,
  onAnswer: (answer: Answer) => void,
  log: (level: 'info' | 'warning', message: string) => void,
  dispatchUrl?: string
): () => void {
```

and add it to the payload:

```typescript
  const payload = {
    id: request.id,
    reason: request.reason,
    kind: request.kind,
    pid: process.pid,
    grantCommand: `tmux-mcp grant ${request.id} <target>`,
    dispatchUrl,
    candidates: request.candidates.map(c => ({ id: c.id, label: c.label })),
  };
```

plus the env var beside the others:

```typescript
      TMUX_MCP_DISPATCH_URL: dispatchUrl ?? '',
```

At the hook call site in `src/index.ts`, pass it:

```typescript
            cleanups.push(spawnAssignHook(assignHookPath, created, requestsDir, answer => {
              void answerRequest(created.id, answer);
            }, logToClient, requestUrl(created.id)));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/human-assigned.test.mjs test/assign-hook.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: replace elicitation with the dispatch service"
```

---

### Task 8: Documentation and the test config

**Files:**
- Modify: `README.md`, `test-configs/.mcp.json`, `test-configs/README.md`
- Modify: `examples/assign-hooks/notify-only.sh` (use `TMUX_MCP_DISPATCH_URL`)

**Interfaces:**
- Consumes: everything.
- Produces: nothing importable.

- [ ] **Step 1: Update the notify-only hook to link to dispatch**

Replace the `body=` line in `examples/assign-hooks/notify-only.sh`:

```bash
body=${TMUX_MCP_DISPATCH_URL:-"tmux-mcp grant ${TMUX_MCP_REQUEST_ID} <target>"}
```

- [ ] **Step 2: Rewrite the README's channel section**

In `README.md`, replace the numbered list of three channels (elicitation, CLI, hook) with:

````markdown
A request is answered outside the agent's client — the agent is in none of
these paths, so it cannot answer its own request:

1. **The dispatch service** — `--ui` starts a local web server (one per machine,
   shared by every tmux-mcp process) at `http://127.0.0.1:7676`. It lists
   pending requests with a **live** target list: a pane you open after
   reading the request is assignable, which a snapshot prompt could never do.

   ```bash
   tmux-mcp ui              # run it yourself
   tmux-mcp ui --print-url  # the URL, including the access token
   tmux-mcp ui --stop
   ```

2. **The CLI** — from any shell, including over SSH:

   ```bash
   tmux-mcp requests
   tmux-mcp grant r-8f3k2 %3
   tmux-mcp deny r-8f3k2 "not now"
   ```

3. **An assign hook** — your own script; mainly to notify you, though it may
   answer by printing an id.

There is deliberately **no MCP elicitation**: prompting inside the agent's
client showed a list frozen at the moment the agent asked, behaved
differently per client, and produced a second prompt whenever a hook was also
configured.

Dispatch binds to `127.0.0.1` only and requires the token from
`~/.tmux-mcp/ui.json` (mode 0600). Whoever can read that file can assign
panes, exactly like whoever can write to the requests directory. Dispatch
itself is **not** scope-restricted: it is your tool and shows all of tmux.
Assignment still respects the scope recorded in each request.
````

Add the flags to the options table:

```markdown
| `--ui` | `TMUX_MCP_DISPATCH` | off | Start/reuse the local dispatch service and link to it in notifications |
| `--state-dir=<path>` | `TMUX_MCP_STATE_DIR` | `~/.tmux-mcp` | Where `ui.json` lives |
| `--port=<n>` (on `tmux-mcp ui`) | `TMUX_MCP_DISPATCH_PORT` | `7676` | Falls back to an ephemeral port when taken |
```

- [ ] **Step 3: Switch the test config to dispatch**

Replace `test-configs/.mcp.json` with (absolute paths, as before):

```json
{
  "mcpServers": {
    "tmux-human-assigned": {
      "command": "node",
      "args": [
        "/Users/frankhommers/Repos/tmux-mcp/build/index.js",
        "--human-assigned",
        "--ui",
        "--requests-dir=/Users/frankhommers/Repos/tmux-mcp/test-configs/requests",
        "--state-dir=/Users/frankhommers/Repos/tmux-mcp/test-configs/state"
      ]
    }
  }
}
```

Add `test-configs/state/` to `.gitignore`.

In `test-configs/README.md`, replace the macOS-dialog section with a dispatch
section: `cd test-configs && claude`, the daemon starts by itself, the URL comes
from `node build/index.js ui --print-url --state-dir=test-configs/state`, and
the thing to try is opening a pane *after* the request and assigning it from
the browser.

- [ ] **Step 4: Verify the whole suite**

Run: `npm test`
Expected: every test passes.

Run: `tmux list-sessions 2>/dev/null | grep tmux-mcp- || echo "no leaked sessions"`
Expected: `no leaked sessions`.

Run: `pgrep -f "build/index.js ui" || echo "no stray daemons"`
Expected: `no stray daemons`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: document the dispatch service and use it in the test config"
```

---

## Self-Review Notes

Spec coverage against `docs/plans/2026-09-02-control-ui-design.md` (milestone 1 only):

| Spec section | Task |
|---|---|
| `ui.json` contents, 0600, state dir | 1 |
| Liveness (`kill(pid,0)` + `/api/health`) | 1, 5 |
| Spawn lock, stale lock takeover | 1, 5 |
| Daemon binds 127.0.0.1, token auth, Host/Origin checks | 2 |
| `tmux-mcp ui` / `--detached` / `--print-url` / `--stop` | 5 |
| Port default 7676, ephemeral fallback | 5 |
| Auto-spawn from the MCP server, never fatal | 5, 7 |
| `GET /api/health` | 2 |
| Requests, live targets, grant, deny | 3 |
| Targets filtered by the request's recorded scope | 3 |
| SSE `request-added` / `request-answered` | 4 |
| Pages `/` and `/r/<id>`, no framework | 6 |
| Browser notification for an open tab | 6 |
| Elicitation deleted | 7 |
| Notifications carrying the request URL (tmux, MCP log, hook `dispatchUrl`) | 7, 8 |
| Documentation, test config | 8 |

Deferred to later milestones by design: `tmux-changed` SSE and every
`/api/tmux`, `/api/clients`, `/api/sessions`, `/api/windows`, `/api/panes`
endpoint (milestone 2); `/api/panes/:id/content` and `/stream`, and
`@xterm/xterm` (milestone 3). Desktop notifications *from the daemon*
(`terminal-notifier`/`notify-send`) also move to milestone 2: in milestone 1
the notify-only hook already covers that path, and the daemon has no reason
to shell out yet.
