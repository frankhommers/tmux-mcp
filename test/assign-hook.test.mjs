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
    setTimeout(() => { kill(); clearTimeout(timer); resolve(null); }, 3000);
  });
}

test('a hook that prints a candidate id grants it', async () => {
  const path = await hookScript('echo "%5"');
  assert.deepEqual(await runHook(path), { status: 'granted', target: '%5', via: 'hook' });
});

test('a hook receives the request as JSON on stdin', async () => {
  const path = await hookScript('payload=$(cat); echo "$payload" | grep -q "run the tests" && echo "%3"');
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

test('output that is not an id is ignored', async () => {
  const path = await hookScript('echo "maybe later"');
  assert.equal(await runHook(path), null);
});

test('an id outside the offered list is passed on for live validation', async () => {
  // The hook may name a pane the human opened after reading the request.
  const path = await hookScript('echo "%42"');
  assert.deepEqual(await runHook(path), { status: 'granted', target: '%42', via: 'hook' });
});

import { access, constants } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('shipped example hooks are executable and follow the contract', async () => {
  for (const name of ['tmux-popup.sh', 'macos-dialog.sh', 'notify-only.sh']) {
    await access(new URL(`../examples/assign-hooks/${name}`, import.meta.url), constants.X_OK);
  }
  // notify-only never answers, whatever the request looks like.
  const answer = await new Promise(resolve => {
    spawnAssignHook(
      fileURLToPath(new URL('../examples/assign-hooks/notify-only.sh', import.meta.url)),
      REQUEST,
      '/tmp',
      () => resolve('answered'),
      () => {}
    );
    setTimeout(() => resolve(null), 2500);
  });
  assert.equal(answer, null);
});
