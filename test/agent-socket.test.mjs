import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocketServer } from 'ws';

import { AgentSocket } from '../build/agent-socket.js';
import { PROTOCOL_VERSION } from '../build/protocol.js';

/**
 * A stand-in dispatch service. Records everything the agent sends and lets a test
 * reply, so the agent's half of the protocol is exercised for real over a
 * socket rather than against a mock object.
 */
async function withFakeUi(behaviour, run) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => wss.once('listening', resolve));
  const { port } = wss.address();

  const received = [];
  const connections = [];
  const headers = [];

  wss.on('connection', (socket, request) => {
    connections.push(socket);
    headers.push(request.headers);
    socket.on('message', data => {
      const message = JSON.parse(String(data));
      received.push(message);
      behaviour?.(socket, message, { received, connections });
    });
  });

  const state = {
    url: `ws://127.0.0.1:${port}/agent`,
    received,
    connections,
    headers,
    waitFor: async (type, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = received.find(m => m.type === type);
        if (found) return found;
        await new Promise(r => setTimeout(r, 20));
      }
      throw new Error(`no ${type} within ${timeoutMs}ms; got ${JSON.stringify(received)}`);
    },
  };

  try {
    await run(state);
  } finally {
    for (const socket of connections) socket.close();
    await new Promise(resolve => wss.close(resolve));
  }
}

function makeAgent(url, overrides = {}) {
  return new AgentSocket({
    url,
    token: 'device-token',
    scope: 'none',
    clientVersion: 'tmux-mcp/test',
    onAnswer: async () => ({ ok: true, target: '%3' }),
    onRefresh: async () => [{ id: '%9', label: '%9  fresh' }],
    log: () => {},
    ...overrides,
  });
}

const REQUEST = {
  id: 'r-abc123',
  reason: 'run the test suite',
  kind: 'pane',
  createdAt: Date.now(),
  expiresAt: Date.now() + 1_800_000,
  candidates: [{ id: '%3', label: '%3  main:code.1  zsh' }],
};

function acceptHandshake(socket, message) {
  if (message.type === 'hello') {
    socket.send(JSON.stringify({ type: 'welcome', protocolVersion: PROTOCOL_VERSION, account: 'tester' }));
  }
}

test('offering a request connects, says hello and sends the request', async () => {
  await withFakeUi(acceptHandshake, async ui => {
    const agent = makeAgent(ui.url);
    try {
      agent.offer(REQUEST);

      const hello = await ui.waitFor('hello');
      assert.equal(hello.protocolVersion, PROTOCOL_VERSION);
      assert.equal(hello.agent.pid, process.pid);
      assert.equal(hello.agent.scope, 'none');

      const request = await ui.waitFor('request');
      assert.equal(request.id, REQUEST.id);
      assert.equal(request.reason, 'run the test suite');
      assert.deepEqual(request.candidates, REQUEST.candidates);

      // The device token travels in the handshake, not in a message.
      assert.equal(ui.headers[0].authorization, 'Bearer device-token');
    } finally {
      agent.stop();
    }
  });
});

test('an answer is validated here and its outcome reported back', async () => {
  const validated = [];
  await withFakeUi((socket, message) => {
    acceptHandshake(socket, message);
    if (message.type === 'request') {
      socket.send(JSON.stringify({ type: 'answer', id: message.id, target: '%42' }));
    }
  }, async ui => {
    const agent = makeAgent(ui.url, {
      onAnswer: async (id, answer) => {
        validated.push([id, answer]);
        return { ok: true, target: answer.target };
      },
    });
    try {
      agent.offer(REQUEST);
      const result = await ui.waitFor('result');
      assert.equal(result.ok, true);
      assert.equal(result.target, '%42');
      assert.deepEqual(validated, [['r-abc123', { target: '%42' }]]);
    } finally {
      agent.stop();
    }
  });
});

test('a rejected answer is reported and the request stays open', async () => {
  await withFakeUi((socket, message) => {
    acceptHandshake(socket, message);
    if (message.type === 'request') {
      socket.send(JSON.stringify({ type: 'answer', id: message.id, target: '%99' }));
    }
  }, async ui => {
    const agent = makeAgent(ui.url, {
      onAnswer: async () => ({ ok: false, error: '%99 does not exist' }),
    });
    try {
      agent.offer(REQUEST);
      const result = await ui.waitFor('result');
      assert.equal(result.ok, false);
      assert.match(result.error, /does not exist/);
    } finally {
      agent.stop();
    }
  });
});

test('a deny is passed through with its reason', async () => {
  const seen = [];
  await withFakeUi((socket, message) => {
    acceptHandshake(socket, message);
    if (message.type === 'request') {
      socket.send(JSON.stringify({ type: 'answer', id: message.id, deny: true, reason: 'not now' }));
    }
  }, async ui => {
    const agent = makeAgent(ui.url, {
      onAnswer: async (id, answer) => {
        seen.push(answer);
        return { ok: false, error: 'denied' };
      },
    });
    try {
      agent.offer(REQUEST);
      await ui.waitFor('result');
      assert.deepEqual(seen, [{ deny: true, reason: 'not now' }]);
    } finally {
      agent.stop();
    }
  });
});

test('refresh asks this side for a new list and returns it', async () => {
  await withFakeUi((socket, message) => {
    acceptHandshake(socket, message);
    if (message.type === 'request') {
      socket.send(JSON.stringify({ type: 'refresh', id: message.id }));
    }
  }, async ui => {
    const agent = makeAgent(ui.url);
    try {
      agent.offer(REQUEST);
      const candidates = await ui.waitFor('candidates');
      assert.deepEqual(candidates.candidates, [{ id: '%9', label: '%9  fresh' }]);
    } finally {
      agent.stop();
    }
  });
});

test('a different protocol major is refused and the agent gives up', async () => {
  const logs = [];
  await withFakeUi((socket, message) => {
    if (message.type === 'hello') {
      socket.send(JSON.stringify({ type: 'welcome', protocolVersion: '2.0' }));
    }
  }, async ui => {
    const agent = makeAgent(ui.url, { log: (level, msg) => logs.push([level, msg]) });
    try {
      agent.offer(REQUEST);
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !agent.givenUp) await new Promise(r => setTimeout(r, 20));
      assert.equal(agent.givenUp, true, 'the agent should stop using an incompatible dispatch');
      assert.ok(logs.some(([, msg]) => /protocol 2\.0/.test(msg) && /grant/.test(msg)));
    } finally {
      agent.stop();
    }
  });
});

test('an explicit refuse stops the agent from retrying', async () => {
  const logs = [];
  await withFakeUi((socket, message) => {
    if (message.type === 'hello') {
      socket.send(JSON.stringify({ type: 'refuse', reason: 'unauthorized' }));
    }
  }, async ui => {
    const agent = makeAgent(ui.url, { log: (level, msg) => logs.push([level, msg]) });
    try {
      agent.offer(REQUEST);
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !agent.givenUp) await new Promise(r => setTimeout(r, 20));
      assert.equal(agent.givenUp, true);
      assert.ok(logs.some(([, msg]) => /Pair it again/.test(msg)));
    } finally {
      agent.stop();
    }
  });
});

test('withdrawing the last request closes the socket', async () => {
  await withFakeUi(acceptHandshake, async ui => {
    const agent = makeAgent(ui.url);
    try {
      agent.offer(REQUEST);
      await ui.waitFor('request');
      assert.equal(agent.connected, true);

      agent.withdraw(REQUEST.id, 'answered_elsewhere');
      const withdraw = await ui.waitFor('withdraw');
      assert.equal(withdraw.why, 'answered_elsewhere');

      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && agent.connected) await new Promise(r => setTimeout(r, 20));
      assert.equal(agent.connected, false, 'an idle agent should hold no connection');
    } finally {
      agent.stop();
    }
  });
});

test('an unreachable dispatch never throws and leaves the caller to fall back', async () => {
  const logs = [];
  const agent = new AgentSocket({
    url: 'ws://127.0.0.1:1/agent',
    scope: 'none',
    clientVersion: 'tmux-mcp/test',
    onAnswer: async () => ({ ok: false, error: 'unused' }),
    onRefresh: async () => [],
    log: (level, msg) => logs.push([level, msg]),
  });
  try {
    agent.offer(REQUEST);
    await new Promise(r => setTimeout(r, 500));
    assert.equal(agent.connected, false);
  } finally {
    agent.stop();
  }
});

test('the socket reconnects and re-offers open requests', async () => {
  let connectionCount = 0;
  await withFakeUi((socket, message, state) => {
    acceptHandshake(socket, message);
    if (message.type === 'request') {
      connectionCount = state.connections.length;
      // Drop the first connection to force a reconnect.
      if (connectionCount === 1) socket.terminate();
    }
  }, async ui => {
    const agent = makeAgent(ui.url);
    try {
      agent.offer(REQUEST);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && ui.received.filter(m => m.type === 'request').length < 2) {
        await new Promise(r => setTimeout(r, 50));
      }
      assert.ok(
        ui.received.filter(m => m.type === 'request').length >= 2,
        'the open request should be offered again after reconnecting'
      );
    } finally {
      agent.stop();
    }
  });
});

test('reporting grants dials in and sends what is currently granted', async () => {
  await withFakeUi(
    (socket, message) => {
      if (message.type === 'hello') {
        socket.send(JSON.stringify({ type: 'welcome', protocolVersion: PROTOCOL_VERSION }));
      }
    },
    async ui => {
      const agent = makeAgent(ui.url, {
        listGrants: () => [{ target: '%3', kind: 'pane', label: '%3  agents:0.1', since: 1000 }],
      });
      agent.reportGrants();
      const grants = await ui.waitFor('grants');
      assert.deepEqual(grants.grants, [
        { target: '%3', kind: 'pane', label: '%3  agents:0.1', since: 1000 },
      ]);
      agent.stop();
    }
  );
});

test('after reporting grants with nothing pending, the socket hangs up again', async () => {
  await withFakeUi(
    (socket, message) => {
      if (message.type === 'hello') {
        socket.send(JSON.stringify({ type: 'welcome', protocolVersion: PROTOCOL_VERSION }));
      }
    },
    async ui => {
      const agent = makeAgent(ui.url, { listGrants: () => [] });
      agent.reportGrants();
      await ui.waitFor('grants');

      const deadline = Date.now() + 2000;
      while (agent.connected && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
      assert.equal(agent.connected, false, 'an idle agent should not keep the socket open');
      agent.stop();
    }
  );
});

test('a revoke from dispatch drops the grant and reports what is left', async () => {
  const held = new Map([
    ['%3', { target: '%3', kind: 'pane', label: '%3  a', since: 1 }],
    ['%4', { target: '%4', kind: 'pane', label: '%4  b', since: 2 }],
  ]);
  await withFakeUi(
    (socket, message) => {
      if (message.type === 'hello') {
        socket.send(JSON.stringify({ type: 'welcome', protocolVersion: PROTOCOL_VERSION }));
        socket.send(JSON.stringify({ type: 'revoke', target: '%3' }));
      }
    },
    async ui => {
      const agent = makeAgent(ui.url, {
        listGrants: () => [...held.values()],
        onRevoke: target => held.delete(target),
      });
      agent.reportGrants();

      const deadline = Date.now() + 4000;
      let last;
      while (Date.now() < deadline) {
        const reports = ui.received.filter(m => m.type === 'grants');
        last = reports.at(-1);
        if (last && last.grants.length === 1) break;
        await new Promise(r => setTimeout(r, 20));
      }
      assert.deepEqual(last?.grants.map(g => g.target), ['%4'], 'the revoked pane should be gone');
      assert.equal(held.has('%3'), false, 'the server should have dropped the grant');
      agent.stop();
    }
  );
});

test('the same process keeps one identity across a reconnect', async () => {
  await withFakeUi(
    (socket, message) => {
      if (message.type === 'hello') {
        socket.send(JSON.stringify({ type: 'welcome', protocolVersion: PROTOCOL_VERSION }));
      }
    },
    async ui => {
      const agent = makeAgent(ui.url, { listGrants: () => [] });

      agent.reportGrants();
      const first = await ui.waitFor('hello');
      assert.ok(first.agent.instanceId, 'hello should carry a stable instance id');

      // Drop the socket the way a restart of the service would.
      ui.connections.at(-1).close();
      await new Promise(r => setTimeout(r, 200));
      agent.reportGrants();

      const deadline = Date.now() + 4000;
      while (ui.received.filter(m => m.type === 'hello').length < 2 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 20));
      }
      const hellos = ui.received.filter(m => m.type === 'hello');
      assert.equal(hellos.length, 2, 'the agent should have dialled in again');
      assert.equal(hellos[1].agent.instanceId, hellos[0].agent.instanceId,
        'a reconnect is the same server, so the instance id must not change');
      agent.stop();
    }
  );
});

test('confirming a target asks dispatch and honours a refusal', async () => {
  await withFakeUi(
    (socket, message) => {
      if (message.type === 'hello') {
        socket.send(JSON.stringify({ type: 'welcome', protocolVersion: PROTOCOL_VERSION }));
      }
      if (message.type === 'check') {
        socket.send(JSON.stringify({ type: 'verdict', id: message.id, allowed: message.target === '%4' }));
      }
    },
    async ui => {
      const agent = makeAgent(ui.url, { listGrants: () => [] });
      assert.equal(await agent.confirm('%4'), true, 'dispatch allowed this one');
      assert.equal(await agent.confirm('%3'), false, 'dispatch revoked this one');
      agent.stop();
    }
  );
});

test('an unreachable dispatch does not lock the agent out of what it holds', async () => {
  const agent = makeAgent('ws://127.0.0.1:1/agent', { listGrants: () => [], confirmTimeoutMs: 300 });
  assert.equal(await agent.confirm('%3'), true,
    'with no dispatch to ask, the local grant is what decides');
  agent.stop();
});

test('every handshake re-offers the grants, so a restarted dispatch relearns them', async () => {
  await withFakeUi(acceptHandshake, async ui => {
    const agent = makeAgent(ui.url, {
      listGrants: () => [{ target: '%7', kind: 'pane', label: '%7  agents:0.2', since: 2000 }],
    });
    try {
      // A request, not a report: dispatch still ends up knowing what is held.
      agent.offer(REQUEST);
      const grants = await ui.waitFor('grants');
      assert.deepEqual(grants.grants, [
        { target: '%7', kind: 'pane', label: '%7  agents:0.2', since: 2000 },
      ]);
    } finally {
      agent.stop();
    }
  });
});

test('a refused check drops the grant, the same way a revoke does', async () => {
  const held = new Map([
    ['%3', { target: '%3', kind: 'pane', label: '%3  a', since: 1 }],
    ['%4', { target: '%4', kind: 'pane', label: '%4  b', since: 2 }],
  ]);
  await withFakeUi(
    (socket, message) => {
      if (message.type === 'hello') {
        socket.send(JSON.stringify({ type: 'welcome', protocolVersion: PROTOCOL_VERSION }));
      }
      if (message.type === 'check') {
        socket.send(JSON.stringify({ type: 'verdict', id: message.id, allowed: false }));
      }
    },
    async ui => {
      const agent = makeAgent(ui.url, {
        listGrants: () => [...held.values()],
        onRevoke: target => held.delete(target),
      });
      try {
        assert.equal(await agent.confirm('%3'), false);
        assert.equal(held.has('%3'), false, 'a pane we were refused is no longer ours');

        const deadline = Date.now() + 4000;
        let last;
        while (Date.now() < deadline) {
          last = ui.received.filter(m => m.type === 'grants').at(-1);
          if (last && last.grants.length === 1) break;
          await new Promise(r => setTimeout(r, 20));
        }
        assert.deepEqual(last?.grants.map(g => g.target), ['%4'], 'and dispatch should be told');
      } finally {
        agent.stop();
      }
    }
  );
});

test('a server that shuts down says it holds nothing any more', async () => {
  await withFakeUi(acceptHandshake, async ui => {
    const agent = makeAgent(ui.url, {
      listGrants: () => [{ target: '%3', kind: 'pane', label: '%3  a', since: 1 }],
    });
    agent.reportGrants();
    await ui.waitFor('grants');

    // Grants live in this process's memory, so they end with it.
    agent.stop();

    const deadline = Date.now() + 2000;
    let last;
    while (Date.now() < deadline) {
      last = ui.received.filter(m => m.type === 'grants').at(-1);
      if (last && last.grants.length === 0) break;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.deepEqual(last?.grants, [], 'dispatch should not keep showing a dead process\'s pane');
  });
});

test('a check still gets through when the previous socket is only just closing', async () => {
  await withFakeUi(
    (socket, message) => {
      if (message.type === 'hello') {
        socket.send(JSON.stringify({ type: 'welcome', protocolVersion: PROTOCOL_VERSION }));
      }
      if (message.type === 'check') {
        socket.send(JSON.stringify({ type: 'verdict', id: message.id, allowed: false }));
      }
    },
    async ui => {
      const agent = makeAgent(ui.url, { listGrants: () => [], confirmTimeoutMs: 1000 });
      try {
        agent.offer(REQUEST);
        await ui.waitFor('request');

        // Settling the last request hangs up. Acting straight afterwards is the
        // normal case, and the old socket's farewell must not swallow the new one.
        agent.withdraw(REQUEST.id, 'answered_elsewhere');
        const allowed = await agent.confirm('%3');

        assert.equal(allowed, false, 'dispatch said no; falling back to the local grant loses a revocation');
      } finally {
        agent.stop();
      }
    }
  );
});

test('hello says which tmux server this agent is on', async () => {
  await withFakeUi(acceptHandshake, async ui => {
    const agent = makeAgent(ui.url, { listGrants: () => [] });
    try {
      agent.offer(REQUEST);
      const hello = await ui.waitFor('hello');
      // Read afresh per connection: tmux can restart under a long-lived server,
      // and a stale fingerprint would let a rule hand out the wrong pane.
      assert.match(hello.agent.tmuxServer, /^\/.+:\d+:\d+$/,
        `expected socket:pid:start_time, got ${hello.agent.tmuxServer}`);
    } finally {
      agent.stop();
    }
  });
});

test('hello names the client that started this server', async () => {
  await withFakeUi(acceptHandshake, async ui => {
    const agent = makeAgent(ui.url, { listGrants: () => [], mcpClient: () => 'opencode' });
    try {
      agent.offer(REQUEST);
      const hello = await ui.waitFor('hello');
      assert.equal(hello.agent.mcpClient, 'opencode',
        'a pid alone does not tell a human which agent this is');
    } finally {
      agent.stop();
    }
  });
});
