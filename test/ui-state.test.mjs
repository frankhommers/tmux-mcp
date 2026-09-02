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
  assert.equal(await acquireSpawnLock(dir, -1), true);
});
