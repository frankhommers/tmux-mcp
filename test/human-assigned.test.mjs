import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { executeTmux, listAllPanes, listAllWindowIds } from '../build/tmux.js';

test('listAllPanes reports ids, names and current command', async () => {
  const sessionName = `tmux-mcp-inventory-${process.pid}-${randomUUID()}`;
  await executeTmux(['new-session', '-d', '-s', sessionName]);
  try {
    const panes = await listAllPanes();
    const mine = panes.filter(p => p.sessionName === sessionName);
    assert.equal(mine.length, 1);
    assert.match(mine[0].paneId, /^%\d+$/);
    assert.match(mine[0].windowId, /^@\d+$/);
    assert.match(mine[0].sessionId, /^\$\d+$/);
    assert.equal(mine[0].paneIndex, '0');
    assert.ok(mine[0].currentCommand.length > 0);

    const windowIds = await listAllWindowIds();
    assert.ok(windowIds.includes(mine[0].windowId));
  } finally {
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});

import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function resultText(result) {
  assert.equal(result.content[0]?.type, 'text');
  return result.content[0].text;
}

async function startHumanAssignedServer(extraArgs = []) {
  const requestsDir = await mkdtemp(join(tmpdir(), 'tmux-mcp-ha-'));
  const client = new Client({ name: 'human-assigned-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js', '--human-assigned', `--requests-dir=${requestsDir}`, ...extraArgs],
    cwd: process.cwd(),
    stderr: 'pipe',
  });
  await client.connect(transport);
  return { client, transport, requestsDir };
}

async function waitForRequestId(dir) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const entries = await readdir(dir);
    const file = entries.find(entry => entry.endsWith('.json'));
    if (file) return file.slice(0, -'.json'.length);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('no request file appeared');
}

test('without a grant the agent sees nothing and can request a pane', async () => {
  const sessionName = `tmux-mcp-ha-${process.pid}-${randomUUID()}`;
  const paneId = await executeTmux(['new-session', '-d', '-s', sessionName, '-P', '-F', '#{pane_id}']);
  const { client, transport, requestsDir } = await startHumanAssignedServer();

  try {
    const sessions = await client.callTool({ name: 'list-sessions', arguments: {} });
    assert.equal(JSON.parse(resultText(sessions)).length, 0);

    const denied = await client.callTool({
      name: 'capture-pane',
      arguments: { paneId, lines: '5' },
    });
    assert.equal(denied.isError, true);
    assert.match(resultText(denied), /not in the allowed|Access denied/i);

    // The request returns pending; the human answers out of band.
    const pending = client.callTool({
      name: 'request-pane',
      arguments: { reason: 'run the test suite', timeoutSeconds: 20 },
    });

    const requestId = await waitForRequestId(requestsDir);
    const request = JSON.parse(await readFile(join(requestsDir, `${requestId}.json`), 'utf8'));
    assert.equal(request.reason, 'run the test suite');
    assert.ok(request.candidates.some(candidate => candidate.id === paneId));

    await writeFile(join(requestsDir, `${requestId}.grant`), paneId, { mode: 0o600 });

    const granted = await pending;
    assert.ok(!granted.isError);
    assert.match(resultText(granted), /^Status: granted$/m);
    assert.ok(resultText(granted).includes(`Pane: ${paneId}`));

    // The granted pane is now usable and visible.
    const after = await client.callTool({ name: 'capture-pane', arguments: { paneId, lines: '5' } });
    assert.ok(!after.isError);
    const sessionsAfter = await client.callTool({ name: 'list-sessions', arguments: {} });
    assert.equal(JSON.parse(resultText(sessionsAfter)).length, 1);
  } finally {
    await transport.close();
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});

test('an unanswered request returns pending and can be polled', async () => {
  const sessionName = `tmux-mcp-ha-${process.pid}-${randomUUID()}`;
  const paneId = await executeTmux(['new-session', '-d', '-s', sessionName, '-P', '-F', '#{pane_id}']);
  const { client, transport, requestsDir } = await startHumanAssignedServer();

  try {
    const first = await client.callTool({
      name: 'request-pane',
      arguments: { reason: 'later', timeoutSeconds: 1 },
    });
    assert.match(resultText(first), /^Status: pending$/m);
    const requestId = resultText(first).match(/Request ID: (r-[a-z0-9]+)/)[1];

    await writeFile(join(requestsDir, `${requestId}.grant`), paneId, { mode: 0o600 });

    const polled = await client.callTool({
      name: 'request-pane',
      arguments: { reason: 'later', requestId, timeoutSeconds: 10 },
    });
    assert.match(resultText(polled), /^Status: granted$/m);
  } finally {
    await transport.close();
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});

test('a denial is reported to the agent with its reason', async () => {
  const sessionName = `tmux-mcp-ha-${process.pid}-${randomUUID()}`;
  await executeTmux(['new-session', '-d', '-s', sessionName]);
  const { client, transport, requestsDir } = await startHumanAssignedServer();

  try {
    const pendingCall = client.callTool({
      name: 'request-pane',
      arguments: { reason: 'nope', timeoutSeconds: 20 },
    });
    const requestId = await waitForRequestId(requestsDir);
    await writeFile(join(requestsDir, `${requestId}.deny`), 'busy right now', { mode: 0o600 });

    const result = await pendingCall;
    assert.equal(result.isError, true);
    assert.match(resultText(result), /^Status: denied$/m);
    assert.match(resultText(result), /busy right now/);
  } finally {
    await transport.close();
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});

test('splitting a granted pane grants the child pane', async () => {
  const sessionName = `tmux-mcp-ha-${process.pid}-${randomUUID()}`;
  const paneId = await executeTmux(['new-session', '-d', '-s', sessionName, '-P', '-F', '#{pane_id}']);
  const { client, transport, requestsDir } = await startHumanAssignedServer();

  try {
    const pendingCall = client.callTool({
      name: 'request-pane',
      arguments: { reason: 'need a workspace', timeoutSeconds: 20 },
    });
    const requestId = await waitForRequestId(requestsDir);
    await writeFile(join(requestsDir, `${requestId}.grant`), paneId, { mode: 0o600 });
    await pendingCall;

    const split = await client.callTool({
      name: 'split-pane',
      arguments: { paneId, direction: 'vertical' },
    });
    assert.ok(!split.isError);
    const childId = resultText(split).match(/"id": "(%\d+)"/)[1];

    // The child is usable without a second request.
    const capture = await client.callTool({ name: 'capture-pane', arguments: { paneId: childId, lines: '5' } });
    assert.ok(!capture.isError);
  } finally {
    await transport.close();
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});

test('no elicitation is sent, even to a client that supports it', async () => {
  const { ElicitRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const sessionName = `tmux-mcp-ha-${process.pid}-${randomUUID()}`;
  const paneId = await executeTmux(['new-session', '-d', '-s', sessionName, '-P', '-F', '#{pane_id}']);
  const requestsDir = await mkdtemp(join(tmpdir(), 'tmux-mcp-ha-'));

  const client = new Client(
    { name: 'elicit-capable-test', version: '1.0.0' },
    { capabilities: { elicitation: {} } }
  );
  const seen = [];
  client.setRequestHandler(ElicitRequestSchema, request => {
    seen.push(request.params);
    return { action: 'accept', content: { target: paneId } };
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js', '--human-assigned', `--requests-dir=${requestsDir}`],
    cwd: process.cwd(),
    stderr: 'pipe',
  });

  try {
    await client.connect(transport);
    const first = await client.callTool({
      name: 'request-pane',
      arguments: { reason: 'run the linter', timeoutSeconds: 2 },
    });
    // The request must wait for a human, not be answered by the client.
    assert.match(resultText(first), /^Status: pending$/m);
    assert.equal(seen.length, 0);
  } finally {
    await transport.close();
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});


test('the tmux fingerprint names the server we are talking to, and is stable', async () => {
  const { tmuxServerFingerprint } = await import('../build/tmux.js');
  const first = await tmuxServerFingerprint();
  const [socket, pid, startedAt] = first.split(':');
  assert.ok(socket.startsWith('/'), `expected a socket path, got ${socket}`);
  assert.match(pid, /^\d+$/);
  assert.match(startedAt, /^\d+$/);
  // Nothing restarted in between, so asking twice must agree: this is what a
  // grant's validity hangs on.
  assert.equal(await tmuxServerFingerprint(), first);
});
