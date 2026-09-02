import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRequest,
  getRequest,
  answerRequest,
  waitForAnswer,
  expireRequests,
  resetRequests,
} from '../build/requests.js';

const CANDIDATES = [
  { id: '%3', label: '%3  main:code.1  zsh  "logs"', windowId: '@1', sessionId: '$0' },
  { id: '%5', label: '%5  main:code.2  node  "server"', windowId: '@1', sessionId: '$0' },
];

test('a request is pending until answered', async () => {
  resetRequests();
  const req = createRequest('run the tests', 'pane', CANDIDATES);
  assert.match(req.id, /^r-[a-z0-9]+$/);
  assert.equal(getRequest(req.id)?.reason, 'run the tests');

  const answered = answerRequest(req.id, { status: 'granted', target: '%3', via: 'grant' });
  assert.equal(answered, true);

  const answer = await waitForAnswer(req.id, 1000);
  assert.deepEqual(answer, { status: 'granted', target: '%3', via: 'grant' });
});

test('waitForAnswer resolves when the answer arrives later', async () => {
  resetRequests();
  const req = createRequest('run the tests', 'pane', CANDIDATES);
  setTimeout(() => answerRequest(req.id, { status: 'granted', target: '%5', via: 'hook' }), 50);
  const answer = await waitForAnswer(req.id, 2000);
  assert.deepEqual(answer, { status: 'granted', target: '%5', via: 'hook' });
});

test('waitForAnswer returns null on timeout and the request stays pending', async () => {
  resetRequests();
  const req = createRequest('run the tests', 'pane', CANDIDATES);
  assert.equal(await waitForAnswer(req.id, 50), null);
  assert.ok(getRequest(req.id));
  assert.equal(answerRequest(req.id, { status: 'granted', target: '%3', via: 'grant' }), true);
});

test('a target outside the candidate list is refused and the request survives', async () => {
  resetRequests();
  const req = createRequest('run the tests', 'pane', CANDIDATES);
  assert.equal(answerRequest(req.id, { status: 'granted', target: '%99', via: 'grant' }), false);
  assert.ok(getRequest(req.id));
});

test('answering twice is refused', async () => {
  resetRequests();
  const req = createRequest('run the tests', 'pane', CANDIDATES);
  assert.equal(answerRequest(req.id, { status: 'denied', via: 'grant' }), true);
  assert.equal(answerRequest(req.id, { status: 'granted', target: '%3', via: 'hook' }), false);
});

test('expireRequests removes old requests', async () => {
  resetRequests();
  const req = createRequest('run the tests', 'pane', CANDIDATES);
  assert.deepEqual(expireRequests(60_000), []);
  const expired = expireRequests(-1);
  assert.deepEqual(expired, [req.id]);
  assert.equal(getRequest(req.id), undefined);
});
