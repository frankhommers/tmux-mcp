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

/** A stand-in dispatch service plus a real MCP server wired to it. */
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

  const requestsDir = await mkdtemp(join(tmpdir(), 'tmux-dispatchint-'));
  const client = new Client({ name: 'ui-integration', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      'build/index.js', '--human-assigned',
      `--requests-dir=${requestsDir}`,
      `--dispatch-url=ws://127.0.0.1:${port}/agent`,
      '--dispatch-token=device-token',
      ...extraArgs,
    ],
    cwd: process.cwd(),
    stderr: 'pipe',
  });
  await client.connect(transport);

  const waitFor = async (type, timeoutMs = 8000, where = () => true) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = received.find(m => m.type === type && where(m));
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

test('a request reaches dispatch and an answer from it assigns the pane', async () => {
  const sessionName = `tmux-dispatchint-${process.pid}-${randomUUID()}`;
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

test('a pane dispatch names that does not exist is refused, and the request stays open', async () => {
  const sessionName = `tmux-dispatchint-${process.pid}-${randomUUID()}`;
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
  const sessionName = `tmux-dispatchint-${process.pid}-${randomUUID()}`;
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
  const sessionName = `tmux-dispatchint-${process.pid}-${randomUUID()}`;
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

      // Dispatch is connected but silent; the shell wins.
      await writeFile(join(requestsDir, `${id}.grant`), paneId, { mode: 0o600 });

      const granted = await pending;
      assert.match(resultText(granted), /^Status: granted$/m);
      assert.match(resultText(granted), /^Assigned via: grant$/m);
    });
  } finally {
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});

test('an unreachable dispatch does not stop a request from being answered', async () => {
  const sessionName = `tmux-dispatchint-${process.pid}-${randomUUID()}`;
  const paneId = await executeTmux(['new-session', '-d', '-s', sessionName, '-P', '-F', '#{pane_id}']);
  const requestsDir = await mkdtemp(join(tmpdir(), 'tmux-dispatchint-'));
  const client = new Client({ name: 'ui-down', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      'build/index.js', '--human-assigned',
      `--requests-dir=${requestsDir}`,
      '--dispatch-url=ws://127.0.0.1:1/agent',
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

test('once a pane is assigned, the server reports it as a grant', async () => {
  const sessionName = `tmux-dispatchint-${process.pid}-${randomUUID()}`;
  const paneId = await executeTmux(['new-session', '-d', '-s', sessionName, '-P', '-F', '#{pane_id}']);
  try {
    await withServerAndUi(async ({ client, waitFor }) => {
      const pending = client.callTool({
        name: 'request-pane',
        arguments: { reason: 'report my grants', timeoutSeconds: 20 },
      });
      await pending;

      // The handshake already reported an empty set; wait for the one that
      // carries the pane the human just handed over.
      const report = await waitFor('grants', 8000, m => m.grants.length > 0);
      assert.deepEqual(report.grants.map(g => g.target), [paneId]);
      assert.equal(report.grants[0].kind, 'pane');
      assert.ok(report.grants[0].label.includes(sessionName),
        `the label should say where the pane lives, got ${report.grants[0].label}`);
      assert.equal(report.grants[0].reason, 'report my grants',
        'why the pane was handed over outlives the request that asked for it');
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

test('a pane dispatch has since revoked is refused at the next action', async () => {
  const sessionName = `tmux-dispatchint-${process.pid}-${randomUUID()}`;
  const paneId = await executeTmux(['new-session', '-d', '-s', sessionName, '-P', '-F', '#{pane_id}']);
  let stillAllowed = true;
  try {
    await withServerAndUi(async ({ client }) => {
      const granted = await client.callTool({
        name: 'request-pane',
        arguments: { reason: 'then take it back', timeoutSeconds: 20 },
      });
      assert.match(resultText(granted), /^Status: granted$/m);

      const ok = await client.callTool({ name: 'capture-pane', arguments: { paneId } });
      assert.ok(!resultText(ok).includes('Access denied'), 'while allowed, the pane works');

      stillAllowed = false;
      const denied = await client.callTool({ name: 'capture-pane', arguments: { paneId } });
      assert.match(resultText(denied), /Access denied/,
        'once dispatch says no, the very next action must be refused');
    }, {
      behaviour: (socket, message) => {
        if (message.type === 'request') {
          socket.send(JSON.stringify({ type: 'answer', id: message.id, target: paneId }));
        }
        if (message.type === 'check') {
          socket.send(JSON.stringify({ type: 'verdict', id: message.id, allowed: stillAllowed }));
        }
      },
    });
  } finally {
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});

test('a pane typed in by hand is still described properly', async () => {
  const sessionName = `tmux-dispatchint-${process.pid}-${randomUUID()}`;
  await executeTmux(['new-session', '-d', '-s', sessionName]);
  let typedPane = null;
  try {
    await withServerAndUi(async ({ client, waitFor }) => {
      const pending = client.callTool({
        name: 'request-pane',
        arguments: { reason: 'typed by hand', timeoutSeconds: 20 },
      });
      const request = await waitFor('request');

      // Opened after the request, so the human can only have typed its id.
      const window = await executeTmux(['new-window', '-d', '-t', sessionName, '-P', '-F', '#{window_id}']);
      typedPane = await executeTmux(['list-panes', '-t', window, '-F', '#{pane_id}']);
      assert.ok(!request.candidates.some(c => c.id === typedPane), 'it must not be in the list');

      // The first report carries the bare id; the description follows once
      // tmux has been asked about it.
      const report = await waitFor('grants', 8000,
        m => m.grants.some(g => g.target === typedPane && g.label !== typedPane));
      const grant = report.grants.find(g => g.target === typedPane);
      assert.ok(grant.label.includes(sessionName),
        `a typed pane deserves the same description as a picked one, got ${grant.label}`);

      await pending;
    }, {
      behaviour: (socket, message) => {
        // Answer with the late pane the moment it exists, as typing it would.
        if (message.type === 'request') {
          const wait = setInterval(() => {
            if (!typedPane) return;
            clearInterval(wait);
            socket.send(JSON.stringify({ type: 'answer', id: message.id, target: typedPane }));
          }, 100);
        }
      },
    });
  } finally {
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});

test('an agent that already knows which pane it wants may suggest it', async () => {
  const sessionName = `tmux-dispatchint-${process.pid}-${randomUUID()}`;
  const paneId = await executeTmux(['new-session', '-d', '-s', sessionName, '-P', '-F', '#{pane_id}']);
  try {
    await withServerAndUi(async ({ client, waitFor }) => {
      const pending = client.callTool({
        name: 'request-pane',
        arguments: { reason: 'the deploy already runs there', suggest: paneId, timeoutSeconds: 3 },
      });

      const request = await waitFor('request');
      assert.equal(request.suggested, paneId, 'the suggestion should travel with the request');

      // A suggestion is not an assignment: nothing is usable until a human says so.
      const denied = await client.callTool({ name: 'capture-pane', arguments: { paneId } });
      assert.ok(denied.isError, 'suggesting a pane must not hand it over');

      await pending;
    });
  } finally {
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});
