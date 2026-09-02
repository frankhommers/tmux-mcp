import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { executeTmux } from '../build/tmux.js';

const run = promisify(execFile);

function cli(dir, args) {
  return run(process.execPath, ['build/index.js', ...args, `--requests-dir=${dir}`], { cwd: process.cwd() });
}

// A request whose candidate list is deliberately empty and stale: the point
// of these tests is that the CLI works from live tmux state, not the snapshot.
async function withRequest(kind = 'pane') {
  const sessionName = `tmux-mcp-cli-${process.pid}-${randomUUID()}`;
  const paneId = await executeTmux(['new-session', '-d', '-s', sessionName, '-P', '-F', '#{pane_id}']);
  const dir = await mkdtemp(join(tmpdir(), 'tmux-mcp-cli-'));
  const id = 'r-abc123';
  await writeFile(join(dir, `${id}.json`), JSON.stringify({
    id,
    reason: 'run the tests',
    kind,
    createdAt: Date.now(),
    candidates: [],
    scope: { mode: 'none', sessionIds: [], windowId: null, excludedPaneId: null },
  }), { mode: 0o600 });
  return { dir, id, paneId, sessionName };
}

test('requests lists panes that exist now, not the stored snapshot', async () => {
  const { dir, paneId, sessionName } = await withRequest();
  try {
    const { stdout } = await cli(dir, ['requests']);
    assert.match(stdout, /r-abc123/);
    assert.match(stdout, /run the tests/);
    // The pane was never in the request's candidate list.
    assert.ok(stdout.includes(paneId));
  } finally {
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});

test('grant accepts a pane that was not in the candidate list', async () => {
  const { dir, id, paneId, sessionName } = await withRequest();
  try {
    const { stdout } = await cli(dir, ['grant', id, paneId]);
    assert.match(stdout, /Granted/);
    assert.equal((await readFile(join(dir, `${id}.grant`), 'utf8')).trim(), paneId);
  } finally {
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});

test('grant refuses a pane that does not exist', async () => {
  const { dir, id, sessionName } = await withRequest();
  try {
    await assert.rejects(
      () => cli(dir, ['grant', id, '%999999']),
      err => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /cannot be assigned/i);
        return true;
      }
    );
  } finally {
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});

test('grant refuses a pane outside the recorded scope', async () => {
  const { dir, id, paneId, sessionName } = await withRequest();
  try {
    // Rewrite the request as window-scoped to a window the pane is not in.
    await writeFile(join(dir, `${id}.json`), JSON.stringify({
      id,
      reason: 'run the tests',
      kind: 'pane',
      createdAt: Date.now(),
      candidates: [],
      scope: { mode: 'window', sessionIds: [], windowId: '@999999', excludedPaneId: null },
    }), { mode: 0o600 });

    await assert.rejects(
      () => cli(dir, ['grant', id, paneId]),
      err => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /outside the server's scope|cannot be assigned/i);
        return true;
      }
    );
  } finally {
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});

test('deny writes a deny file with the reason', async () => {
  const { dir, id, sessionName } = await withRequest();
  try {
    await cli(dir, ['deny', id, 'not now']);
    assert.equal((await readFile(join(dir, `${id}.deny`), 'utf8')).trim(), 'not now');
  } finally {
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});

test('grant on an unknown request fails cleanly', async () => {
  const { dir, sessionName } = await withRequest();
  try {
    await assert.rejects(
      () => cli(dir, ['grant', 'r-nope', '%3']),
      err => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /no pending request/i);
        return true;
      }
    );
  } finally {
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});
