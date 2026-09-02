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
