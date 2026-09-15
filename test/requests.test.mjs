import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRequest,
  getRequest,
  answerRequest,
  waitForAnswer,
  expireRequests,
  onRequestExpired,
  resetRequests,
  setTargetResolver,
} from '../build/requests.js';

const CANDIDATES = [
  { id: '%3', label: '%3  main:code.1  zsh  "logs"', windowId: '@1', sessionId: '$0' },
  { id: '%5', label: '%5  main:code.2  node  "server"', windowId: '@1', sessionId: '$0' },
];

// Stands in for the live tmux lookup: %3, %5 and the later-created %9 exist,
// %99 does not, and %7 exists but sits outside the static scope.
function fakeResolver() {
  setTargetResolver(async target => {
    if (target === '%99') return { ok: false, reason: `pane ${target} does not exist` };
    if (target === '%7') return { ok: false, reason: `pane ${target} is outside the allowed scope` };
    return { ok: true, windowId: '@1', sessionId: '$0' };
  });
}

test('a request is pending until answered', async () => {
  resetRequests();
  fakeResolver();
  const req = createRequest('run the tests', 'pane', CANDIDATES);
  assert.match(req.id, /^r-[a-z0-9]+$/);
  assert.equal(getRequest(req.id)?.reason, 'run the tests');

  assert.equal(await answerRequest(req.id, { status: 'granted', target: '%3', via: 'grant' }), true);

  const answer = await waitForAnswer(req.id, 1000);
  assert.equal(answer.status, 'granted');
  assert.equal(answer.target, '%3');
});

test('a pane created after the request was made can still be assigned', async () => {
  resetRequests();
  fakeResolver();
  const req = createRequest('run the tests', 'pane', CANDIDATES);

  // %9 did not exist when the candidate list was built.
  assert.ok(!CANDIDATES.some(c => c.id === '%9'));
  assert.equal(await answerRequest(req.id, { status: 'granted', target: '%9', via: 'grant' }), true);

  const answer = await waitForAnswer(req.id, 1000);
  assert.equal(answer.target, '%9');
  assert.equal(answer.windowId, '@1');
  assert.equal(answer.sessionId, '$0');
});

test('a target that does not exist is refused and the request survives', async () => {
  resetRequests();
  fakeResolver();
  const req = createRequest('run the tests', 'pane', CANDIDATES);
  assert.equal(await answerRequest(req.id, { status: 'granted', target: '%99', via: 'grant' }), false);
  assert.ok(getRequest(req.id));
});

test('a target outside the static scope is refused', async () => {
  resetRequests();
  fakeResolver();
  const req = createRequest('run the tests', 'pane', CANDIDATES);
  assert.equal(await answerRequest(req.id, { status: 'granted', target: '%7', via: 'grant' }), false);
  assert.ok(getRequest(req.id));
});

test('waitForAnswer resolves when the answer arrives later', async () => {
  resetRequests();
  fakeResolver();
  const req = createRequest('run the tests', 'pane', CANDIDATES);
  setTimeout(() => void answerRequest(req.id, { status: 'granted', target: '%5', via: 'hook' }), 50);
  const answer = await waitForAnswer(req.id, 2000);
  assert.equal(answer.target, '%5');
  assert.equal(answer.via, 'hook');
});

test('waitForAnswer returns null on timeout and the request stays pending', async () => {
  resetRequests();
  fakeResolver();
  const req = createRequest('run the tests', 'pane', CANDIDATES);
  assert.equal(await waitForAnswer(req.id, 50), null);
  assert.ok(getRequest(req.id));
  assert.equal(await answerRequest(req.id, { status: 'granted', target: '%3', via: 'grant' }), true);
});

test('answering twice is refused', async () => {
  resetRequests();
  fakeResolver();
  const req = createRequest('run the tests', 'pane', CANDIDATES);
  assert.equal(await answerRequest(req.id, { status: 'denied', via: 'grant' }), true);
  assert.equal(await answerRequest(req.id, { status: 'granted', target: '%3', via: 'hook' }), false);
});

test('a denial needs no target and is never resolved', async () => {
  resetRequests();
  setTargetResolver(async () => { throw new Error('resolver must not run for a denial'); });
  const req = createRequest('run the tests', 'pane', CANDIDATES);
  assert.equal(await answerRequest(req.id, { status: 'denied', reason: 'busy', via: 'grant' }), true);
  const answer = await waitForAnswer(req.id, 1000);
  assert.equal(answer.status, 'denied');
  assert.equal(answer.reason, 'busy');
});

test('the settle listener receives the request it belongs to', async () => {
  resetRequests();
  fakeResolver();
  const { onRequestSettled } = await import('../build/requests.js');
  const seen = [];
  onRequestSettled((id, answer, request) => seen.push({ id, answer, kind: request.kind }));
  const req = createRequest('run the tests', 'pane', CANDIDATES);
  await answerRequest(req.id, { status: 'granted', target: '%9', via: 'grant' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, req.id);
  assert.equal(seen[0].kind, 'pane');
  assert.equal(seen[0].answer.windowId, '@1');
});

test('expireRequests removes old requests', async () => {
  resetRequests();
  fakeResolver();
  const req = createRequest('run the tests', 'pane', CANDIDATES);
  assert.deepEqual(expireRequests(60_000), []);
  assert.deepEqual(expireRequests(-1), [req.id]);
  assert.equal(getRequest(req.id), undefined);
});

test('an expiring request is announced, so the channels it went out on can drop it', () => {
  resetRequests();
  fakeResolver();
  const gone = [];
  onRequestExpired(id => gone.push(id));
  const req = createRequest('run the tests', 'pane', CANDIDATES);

  assert.deepEqual(expireRequests(60_000), []);
  assert.deepEqual(gone, [], 'nothing expired, nothing to announce');

  assert.deepEqual(expireRequests(-1), [req.id]);
  assert.deepEqual(gone, [req.id], 'dispatch still shows it until it is told');
});
