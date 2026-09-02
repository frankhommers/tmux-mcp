import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { readUiState, writeUiState } from '../build/ui/state.js';
import { ensureDaemonRunning, probeDaemon } from '../build/cli-ui.js';

const run = promisify(execFile);

test('print-url reports nothing when no daemon runs', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tmux-mcp-ui-'));
  const result = await run(process.execPath, [
    'build/index.js', 'ui', '--print-url', `--state-dir=${stateDir}`,
  ], { cwd: process.cwd() }).catch(err => err);
  assert.match(result.stdout, /not running/i);
});

test('a state file with a dead pid does not count as running', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tmux-mcp-ui-'));
  await writeUiState(stateDir, {
    pid: 2_147_483_646, port: 1, token: 'x'.repeat(32), startedAt: Date.now(), version: '0.0.0',
  });
  assert.equal(await probeDaemon(await readUiState(stateDir)), false);
});

test('ensureDaemonRunning spawns one daemon, and reuses it afterwards', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tmux-mcp-ui-'));
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
  const stateDir = await mkdtemp(join(tmpdir(), 'tmux-mcp-ui-'));
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

test('a second spawn for the same state dir is refused within the cooldown', async () => {
  // The guard that keeps a bad spawn from becoming a loop. Runs in a child so
  // the cooldown map does not leak into the other tests.
  const script = `
    import { mkdtemp } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { ensureDaemonRunning } from './build/cli-ui.js';
    const dir = await mkdtemp(join(tmpdir(), 'tmux-mcp-guard-'));
    // Point at a state dir whose daemon we immediately stop, so the second
    // call has to consider spawning again.
    const first = await ensureDaemonRunning(dir, join(dir, 'requests'));
    process.kill(first.pid, 'SIGTERM');
    await new Promise(r => setTimeout(r, 500));
    const second = await ensureDaemonRunning(dir, join(dir, 'requests'));
    console.log(JSON.stringify({ first: Boolean(first), second: second === null }));
  `;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd() });
  const result = JSON.parse(stdout.trim().split('\n').pop());
  assert.equal(result.first, true);
  assert.equal(result.second, true, 'a second spawn must be refused');
});
