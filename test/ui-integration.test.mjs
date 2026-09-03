import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { executeTmux } from '../build/tmux.js';

function resultText(result) {
  assert.equal(result.content[0]?.type, 'text');
  return result.content[0].text;
}

/** A stand-in control UI plus a real MCP server wired to it. */
async function withServerAndUi(run, { behaviour, extraArgs = [] } = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => wss.once('listening', resolve));
  const { port } = wss.address();
  const received = [];
  const sockets = [];

  wss.on('connection', socket => {
    sockets.push(socket);
    socket.on('message', data => {
      const message = JSON.parse(String(data));
      received.push(message);
      if (message.type === 'hello') {
        socket.send(JSON.stringify({ type: 'welcome', protocolVersion: '1.0', account: 'tester' }));
      }
      behaviour?.(socket, message);
    });
  });

  const requestsDir = await mkdtemp(join(tmpdir(), 'tmux-mcp-uiint-'));
  const client = new Client({ name: 'ui-integration', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      'build/index.js', '--human-assigned',
      `--requests-dir=${requestsDir}`,
      `--ui-url=ws://127.0.0.1:${port}/agent`,
      '--ui-token=device-token',
      ...extraArgs,
    ],
    cwd: process.cwd(),
    stderr: 'pipe',
  });
  await client.connect(transport);

  const waitFor = async (type, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = received.find(m => m.type === type);
      if (found) return found;
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`no ${type}; got ${JSON.stringify(received.map(m => m.type))}`);
  };

  try {
    await run({ client, requestsDir, received, waitFor });
  } finally {
    await transport.close();
    for (const socket of sockets) socket.close();
    await new Promise(resolve => wss.close(resolve));
  }
}

test('a request reaches the UI and an answer from it assigns the pane', async () => {
  const sessionName = `tmux-mcp-uiint-${process.pid}-${randomUUID()}`;
  const paneId = await executeTmux(['new-session', '-d', '-s', sessionName, '-P', '-F', '#{pane_id}']);
  try {
    await withServerAndUi(async ({ client, waitFor }) => {
      const pending = client.callTool({
        name: 'request-pane',
        arguments: { reason: 'run the suite', timeoutSeconds: 20 },
      });

      const request = await waitFor('request');
      assert.equal(request.reason, 'run the suite');
      assert.ok(request.candidates.some(c => c.id === paneId));
      assert.ok(request.expiresAt > request.createdAt);

      const granted = await pending;
      assert.ok(!granted.isError);
      assert.match(resultText(granted), /^Status: granted$/m);
      assert.ok(resultText(granted).includes(`Pane: ${paneId}`));
      assert.match(resultText(granted), /^Assigned via: ui$/m);
    }, {
      behaviour: (socket, message) => {
        if (message.type === 'request') {
          socket.send(JSON.stringify({ type: 'answer', id: message.id, target: paneId }));
        }
      },
    });
  } finally {
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});

test('a pane the UI names that does not exist is refused, and the request stays open', async () => {
  const sessionName = `tmux-mcp-uiint-${process.pid}-${randomUUID()}`;
  const paneId = await executeTmux(['new-session', '-d', '-s', sessionName, '-P', '-F', '#{pane_id}']);
  try {
    await withServerAndUi(async ({ client, waitFor, received }) => {
      const first = await client.callTool({
        name: 'request-pane',
        arguments: { reason: 'typo', timeoutSeconds: 3 },
      });
      const requestId = resultText(first).match(/Request ID: (r-[a-z0-9]+)/)[1];

      const result = await waitFor('result');
      assert.equal(result.ok, false);
      assert.match(result.error, /does not exist|outside the allowed scope/);

      // Still answerable afterwards.
      const socketMessages = received.filter(m => m.type === 'request');
      assert.equal(socketMessages.length, 1);

      const polled = await client.callTool({
        name: 'request-pane',
        arguments: { reason: 'typo', requestId, timeoutSeconds: 1 },
      });
      assert.match(resultText(polled), /^Status: pending$/m);
    }, {
      behaviour: (socket, message) => {
        if (message.type === 'request') {
          socket.send(JSON.stringify({ type: 'answer', id: message.id, target: '%999999' }));
        }
      },
    });
  } finally {
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});

test('refresh returns panes created after the request was made', async () => {
  const sessionName = `tmux-mcp-uiint-${process.pid}-${randomUUID()}`;
  await executeTmux(['new-session', '-d', '-s', sessionName]);
  let latePane = null;
  try {
    await withServerAndUi(async ({ client, waitFor }) => {
      const pending = client.callTool({
        name: 'request-pane',
        arguments: { reason: 'need a fresh pane', timeoutSeconds: 20 },
      });
      const request = await waitFor('request');

      // The human opens a pane after reading the request, then refreshes.
      const window = await executeTmux(['new-window', '-d', '-t', sessionName, '-P', '-F', '#{window_id}']);
      latePane = await executeTmux(['list-panes', '-t', window, '-F', '#{pane_id}']);
      assert.ok(!request.candidates.some(c => c.id === latePane));

      const candidates = await waitFor('candidates');
      assert.ok(candidates.candidates.some(c => c.id === latePane), 'the new pane should be offered');

      const granted = await pending;
      assert.match(resultText(granted), /^Status: granted$/m);
      assert.ok(resultText(granted).includes(`Pane: ${latePane}`));
    }, {
      behaviour: (socket, message) => {
        if (message.type === 'request') {
          // Ask again a moment later, once the pane exists.
          setTimeout(() => socket.send(JSON.stringify({ type: 'refresh', id: message.id })), 400);
        }
        if (message.type === 'candidates' && latePane) {
          socket.send(JSON.stringify({ type: 'answer', id: message.id, target: latePane }));
        }
      },
    });
  } finally {
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});

test('the request still lands in the requests directory, so the CLI can answer it', async () => {
  const sessionName = `tmux-mcp-uiint-${process.pid}-${randomUUID()}`;
  const paneId = await executeTmux(['new-session', '-d', '-s', sessionName, '-P', '-F', '#{pane_id}']);
  try {
    await withServerAndUi(async ({ client, requestsDir, waitFor }) => {
      const pending = client.callTool({
        name: 'request-pane',
        arguments: { reason: 'answered from the shell', timeoutSeconds: 20 },
      });
      await waitFor('request');

      const files = await readdir(requestsDir);
      const id = files.find(f => f.endsWith('.json')).slice(0, -'.json'.length);
      const stored = JSON.parse(await readFile(join(requestsDir, `${id}.json`), 'utf8'));
      assert.equal(stored.reason, 'answered from the shell');

      // The UI is connected but silent; the shell wins.
      await writeFile(join(requestsDir, `${id}.grant`), paneId, { mode: 0o600 });

      const granted = await pending;
      assert.match(resultText(granted), /^Status: granted$/m);
      assert.match(resultText(granted), /^Assigned via: grant$/m);
    });
  } finally {
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});

test('an unreachable UI does not stop a request from being answered', async () => {
  const sessionName = `tmux-mcp-uiint-${process.pid}-${randomUUID()}`;
  const paneId = await executeTmux(['new-session', '-d', '-s', sessionName, '-P', '-F', '#{pane_id}']);
  const requestsDir = await mkdtemp(join(tmpdir(), 'tmux-mcp-uiint-'));
  const client = new Client({ name: 'ui-down', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      'build/index.js', '--human-assigned',
      `--requests-dir=${requestsDir}`,
      '--ui-url=ws://127.0.0.1:1/agent',
    ],
    cwd: process.cwd(),
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const pending = client.callTool({
      name: 'request-pane',
      arguments: { reason: 'ui is down', timeoutSeconds: 20 },
    });

    const deadline = Date.now() + 5000;
    let id = null;
    while (Date.now() < deadline && !id) {
      const files = await readdir(requestsDir);
      const file = files.find(f => f.endsWith('.json'));
      if (file) id = file.slice(0, -'.json'.length);
      else await new Promise(r => setTimeout(r, 25));
    }
    assert.ok(id, 'the request must still be written for the CLI');

    await writeFile(join(requestsDir, `${id}.grant`), paneId, { mode: 0o600 });
    const granted = await pending;
    assert.match(resultText(granted), /^Status: granted$/m);
  } finally {
    await transport.close();
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});
