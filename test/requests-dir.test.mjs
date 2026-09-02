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

test('a grant file that is still being written is retried, not dropped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmux-mcp-req-'));
  await writeRequestFile(dir, REQUEST);

  const seen = [];
  const stop = startAnswerWatcher(dir, (id, answer) => {
    seen.push([id, answer]);
    return true;
  });
  try {
    // Simulates a non-atomic write: the file exists before it has content.
    await writeAnswerFile(dir, REQUEST.id, 'grant', '');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(seen, []);

    await writeAnswerFile(dir, REQUEST.id, 'grant', '%3');
    await waitUntil(() => seen.length > 0, 5000);
  } finally {
    stop();
  }

  assert.deepEqual(seen[0][1], { status: 'granted', target: '%3', via: 'grant' });
});

test('an answer the server rejects is retried until it is accepted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmux-mcp-req-'));
  await writeRequestFile(dir, REQUEST);

  let attempts = 0;
  const stop = startAnswerWatcher(dir, () => {
    attempts += 1;
    return attempts > 1;
  });
  try {
    await writeAnswerFile(dir, REQUEST.id, 'grant', '%3');
    await waitUntil(() => attempts > 1, 5000);
  } finally {
    stop();
  }

  assert.ok(attempts > 1);
});

test('a request whose server has died is dropped from the inbox', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmux-mcp-req-'));
  const { readdir } = await import('node:fs/promises');

  await writeRequestFile(dir, { ...REQUEST, id: 'r-live', pid: process.pid, createdAt: Date.now() });
  await writeRequestFile(dir, { ...REQUEST, id: 'r-orphan', pid: 2_147_483_646, createdAt: Date.now() });
  await writeRequestFile(dir, { ...REQUEST, id: 'r-old', pid: process.pid, createdAt: Date.now() - 31 * 60 * 1000 });

  const live = await listRequestFiles(dir);
  assert.deepEqual(live.map(r => r.id), ['r-live']);

  // The stale ones are removed, not merely hidden.
  const left = await readdir(dir);
  assert.deepEqual(left.sort(), ['r-live.json']);
});

test('a request file without a pid is judged on age alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmux-mcp-req-'));
  const { pid, ...withoutPid } = { ...REQUEST, pid: 1 };
  await writeRequestFile(dir, { ...withoutPid, id: 'r-legacy', createdAt: Date.now() });
  assert.deepEqual((await listRequestFiles(dir)).map(r => r.id), ['r-legacy']);
});
