import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { startDaemon } from '../build/ui/daemon.js';
import { executeTmux } from '../build/tmux.js';

async function withInbox(run) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tmux-mcp-ui-'));
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
  const sessionName = `tmux-mcp-ui-${process.pid}-${randomUUID()}`;
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
  const sessionName = `tmux-mcp-ui-${process.pid}-${randomUUID()}`;
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
  const sessionName = `tmux-mcp-ui-${process.pid}-${randomUUID()}`;
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
