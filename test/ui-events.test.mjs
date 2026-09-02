import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { startDaemon } from '../build/ui/daemon.js';

test('an arriving request is pushed to a connected client', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tmux-mcp-ui-'));
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
  const stateDir = await mkdtemp(join(tmpdir(), 'tmux-mcp-ui-'));
  const daemon = await startDaemon({ stateDir, requestsDir: join(stateDir, 'requests'), port: 0 });
  try {
    assert.equal((await fetch(`${daemon.url}/events`)).status, 401);
  } finally {
    await daemon.close();
  }
});
