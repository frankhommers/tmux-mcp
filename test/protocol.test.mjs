import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDispatchMessage } from '../build/protocol.js';

test('a revoke frame naming a target is understood', () => {
  const message = parseDispatchMessage(JSON.stringify({ type: 'revoke', target: '%3' }));
  assert.deepEqual(message, { type: 'revoke', target: '%3' });
});
