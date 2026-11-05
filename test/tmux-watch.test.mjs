import assert from 'node:assert/strict';
import test from 'node:test';

import { TmuxServerWatch } from '../build/tmux-watch.js';

const OLD = '/private/tmp/tmux-501/default:6002:1793028578';
const NEW = '/private/tmp/tmux-501/default:4485:1793774769';

function watch(answers, alive = () => false) {
  const queue = [...answers];
  return new TmuxServerWatch({
    fingerprint: async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    isAlive: alive,
  });
}

test('the first server seen is remembered, not reported', async () => {
  assert.equal(await watch([OLD]).poll(), null);
});

test('the same server again is not news', async () => {
  const w = watch([OLD, OLD]);
  await w.poll();
  assert.equal(await w.poll(), null);
});

test('another server on the socket means the old one is gone', async () => {
  const w = watch([OLD, NEW]);
  await w.poll();
  assert.equal(await w.poll(), OLD);
  assert.equal(w.current, NEW);
});

test('no tmux and a dead pid means the old server is gone, once', async () => {
  const w = watch([OLD, new Error('no server running'), new Error('no server running')]);
  await w.poll();
  assert.equal(await w.poll(), OLD);
  assert.equal(await w.poll(), null, 'reported once, not on every poll');
});

test('no answer while its pid still runs is a hiccup, not a death', async () => {
  const w = watch([OLD, new Error('timeout')], pid => pid === 6002);
  await w.poll();
  assert.equal(await w.poll(), null);
  assert.equal(w.current, OLD);
});

test('a server can be named from outside, so grants bind to the one they came from', async () => {
  const w = watch([NEW]);
  w.saw(OLD);
  assert.equal(await w.poll(), OLD);
});
