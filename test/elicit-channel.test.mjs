import assert from 'node:assert/strict';
import test from 'node:test';

import { clientSupportsElicitation, startElicitation } from '../build/elicit-channel.js';

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

function fakeServer(behaviour, capabilities = { elicitation: {} }) {
  const calls = [];
  return {
    calls,
    getClientCapabilities: () => capabilities,
    elicitInput: async (params, options) => {
      calls.push({ params, options });
      return behaviour();
    },
  };
}

function answerOf(server) {
  return new Promise(resolve => {
    startElicitation(server, REQUEST, resolve, () => {});
    setTimeout(() => resolve(null), 1000);
  });
}

test('detects elicitation capability', () => {
  assert.equal(clientSupportsElicitation(fakeServer(() => {})), true);
  assert.equal(clientSupportsElicitation(fakeServer(() => {}, {})), false);
  assert.equal(clientSupportsElicitation({ getClientCapabilities: () => undefined }), false);
});

test('accept becomes a grant and the schema offers every candidate', async () => {
  const server = fakeServer(() => ({ action: 'accept', content: { target: '%5' } }));
  const answer = await answerOf(server);
  assert.deepEqual(answer, { status: 'granted', target: '%5', via: 'elicitation' });

  const schema = server.calls[0].params.requestedSchema;
  assert.deepEqual(schema.properties.target.enum, ['%3', '%5', 'deny']);
  assert.equal(schema.properties.target.enumNames.length, 3);
  assert.match(server.calls[0].params.message, /run the tests/);
});

test('choosing deny in the form is a denial', async () => {
  const server = fakeServer(() => ({ action: 'accept', content: { target: 'deny' } }));
  assert.deepEqual(await answerOf(server), { status: 'denied', reason: undefined, via: 'elicitation' });
});

test('decline is a denial', async () => {
  const server = fakeServer(() => ({ action: 'decline' }));
  assert.deepEqual(await answerOf(server), { status: 'denied', reason: undefined, via: 'elicitation' });
});

test('cancel produces no answer, leaving other channels to decide', async () => {
  const server = fakeServer(() => ({ action: 'cancel' }));
  assert.equal(await answerOf(server), null);
});

test('a throwing client produces no answer and is logged', async () => {
  const server = fakeServer(() => { throw new Error('not supported'); });
  const logged = [];
  const answer = await new Promise(resolve => {
    startElicitation(server, REQUEST, resolve, (level, msg) => logged.push([level, msg]));
    setTimeout(() => resolve(null), 500);
  });
  assert.equal(answer, null);
  assert.ok(logged.some(([level]) => level === 'warning'));
});

test('an unknown target from the client is ignored', async () => {
  const server = fakeServer(() => ({ action: 'accept', content: { target: '%99' } }));
  assert.equal(await answerOf(server), null);
});
