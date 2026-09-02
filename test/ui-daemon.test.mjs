import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { request as httpRequest } from 'node:http';

import { startDaemon } from '../build/ui/daemon.js';

// fetch() refuses to set Host (a forbidden header), so a rebinding attempt has
// to be made with a raw request.
function rawGet(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

async function withDaemon(run) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tmux-mcp-ui-'));
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
    assert.equal((await fetch(`${daemon.url}/api/requests`)).status, 401);
  });
});

test('a wrong token is refused', async () => {
  await withDaemon(async daemon => {
    const res = await fetch(`${daemon.url}/api/requests`, { headers: { Authorization: 'Bearer wrong' } });
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
    assert.equal(await rawGet(daemon.port, '/api/health', { Host: 'evil.example.com' }), 403);
    // A literal loopback Host still works.
    assert.equal(await rawGet(daemon.port, '/api/health', { Host: `127.0.0.1:${daemon.port}` }), 200);
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
  const stateDir = await mkdtemp(join(tmpdir(), 'tmux-mcp-ui-'));
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
