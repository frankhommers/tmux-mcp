import assert from 'node:assert/strict';
import test from 'node:test';

import {
  revokeGrant,
  addGrant,
  isPaneGranted,
  isWindowGranted,
  isSessionGranted,
  hasAnyGrant,
  listGrants,
  pruneGrants,
  resetGrants,
} from '../build/grants.js';

test('starts empty: nothing is granted', () => {
  resetGrants();
  assert.equal(hasAnyGrant(), false);
  assert.equal(isPaneGranted('%1', '@1'), false);
  assert.equal(isWindowGranted('@1'), false);
  assert.equal(isSessionGranted('$0'), false);
  assert.deepEqual(listGrants(), []);
});

test('a granted pane is allowed, its neighbours are not', () => {
  resetGrants();
  addGrant({ kind: 'pane', id: '%3', windowId: '@1', sessionId: '$0' });
  assert.equal(isPaneGranted('%3', '@1'), true);
  assert.equal(isPaneGranted('%4', '@1'), false);
  // A pane grant does not imply access to the whole window.
  assert.equal(isWindowGranted('@1'), false);
  // The session is visible so list-sessions can show the path to the pane.
  assert.equal(isSessionGranted('$0'), true);
  assert.equal(isSessionGranted('$1'), false);
  assert.equal(hasAnyGrant(), true);
});

test('a granted window covers every pane inside it', () => {
  resetGrants();
  addGrant({ kind: 'window', id: '@2', windowId: '@2', sessionId: '$0' });
  assert.equal(isWindowGranted('@2'), true);
  assert.equal(isPaneGranted('%9', '@2'), true);
  assert.equal(isPaneGranted('%9', '@3'), false);
});

test('adding the same grant twice does not duplicate it', () => {
  resetGrants();
  addGrant({ kind: 'pane', id: '%3', windowId: '@1', sessionId: '$0' });
  addGrant({ kind: 'pane', id: '%3', windowId: '@1', sessionId: '$0' });
  assert.equal(listGrants().length, 1);
});

test('pruneGrants drops resources that no longer exist', () => {
  resetGrants();
  addGrant({ kind: 'pane', id: '%3', windowId: '@1', sessionId: '$0' });
  addGrant({ kind: 'pane', id: '%4', windowId: '@1', sessionId: '$0' });
  addGrant({ kind: 'window', id: '@2', windowId: '@2', sessionId: '$0' });

  const removed = pruneGrants(new Set(['%3']), new Set(['@1']));

  assert.deepEqual(removed.sort(), ['%4', '@2']);
  assert.equal(isPaneGranted('%3', '@1'), true);
  assert.equal(isPaneGranted('%4', '@1'), false);
  assert.equal(isWindowGranted('@2'), false);
});

import { initScope, initHumanAssigned, isHumanAssigned, isInScope } from '../build/scope.js';

test('human-assigned denies everything until something is granted', async () => {
  resetGrants();
  initScope('none');
  initHumanAssigned(true);
  assert.equal(isHumanAssigned(), true);
  // No tmux call needed: a window id short-circuits on the grant check.
  assert.equal(await isInScope('@1', 'window'), false);
  assert.equal(await isInScope('$0', 'session'), false);
});

test('human-assigned allows a granted window and its session', async () => {
  resetGrants();
  initScope('none');
  initHumanAssigned(true);
  addGrant({ kind: 'window', id: '@2', windowId: '@2', sessionId: '$0' });
  assert.equal(await isInScope('@2', 'window'), true);
  assert.equal(await isInScope('@3', 'window'), false);
  assert.equal(await isInScope('$0', 'session'), true);
  assert.equal(await isInScope('$1', 'session'), false);
  initHumanAssigned(false);
});

test('revoking a granted pane takes the access away again', () => {
  resetGrants();
  addGrant({ kind: 'pane', id: '%3', windowId: '@1', sessionId: '$0' });
  assert.equal(isPaneGranted('%3', '@1'), true);

  assert.equal(revokeGrant('%3'), true, 'revoking should report that it held something');
  assert.equal(isPaneGranted('%3', '@1'), false, 'the pane should no longer be reachable');
});

test('revoking something that was never granted reports nothing was held', () => {
  resetGrants();
  assert.equal(revokeGrant('%99'), false);
});
