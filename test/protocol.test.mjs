import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDispatchMessage } from '../build/protocol.js';

test('a revoke frame naming a target is understood', () => {
  const message = parseDispatchMessage(JSON.stringify({ type: 'revoke', target: '%3' }));
  assert.deepEqual(message, { type: 'revoke', target: '%3' });
});

test('inventory validation only accepts concrete tmux ids', () => {
  const message = { type: 'validate', id: 'v-1', tmuxServer: '/socket:1:100', targets: ['%3', '@4'] };
  assert.deepEqual(parseDispatchMessage(JSON.stringify(message)), message);
  for (const targets of [['*agents:*'], [null], ['%3', 4], '%3']) {
    assert.equal(parseDispatchMessage(JSON.stringify({ ...message, targets })), null);
  }
});
