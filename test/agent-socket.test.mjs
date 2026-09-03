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
