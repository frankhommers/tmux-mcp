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
