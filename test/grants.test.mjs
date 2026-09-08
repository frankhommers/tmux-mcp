import assert from 'node:assert/strict';
import test from 'node:test';

const TEST_SERVER = '/private/tmp/tmux-501/default:16186:1788462695';

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
  bindGrantsToServer,
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
  addGrant({ kind: 'pane', id: '%3', windowId: '@1', sessionId: '$0' }, TEST_SERVER);
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
  addGrant({ kind: 'window', id: '@2', windowId: '@2', sessionId: '$0' }, TEST_SERVER);
  assert.equal(isWindowGranted('@2'), true);
  assert.equal(isPaneGranted('%9', '@2'), true);
  assert.equal(isPaneGranted('%9', '@3'), false);
});

test('adding the same grant twice does not duplicate it', () => {
  resetGrants();
  addGrant({ kind: 'pane', id: '%3', windowId: '@1', sessionId: '$0' }, TEST_SERVER);
  addGrant({ kind: 'pane', id: '%3', windowId: '@1', sessionId: '$0' }, TEST_SERVER);
  assert.equal(listGrants().length, 1);
});

test('pruneGrants drops resources that no longer exist', () => {
  resetGrants();
  addGrant({ kind: 'pane', id: '%3', windowId: '@1', sessionId: '$0' }, TEST_SERVER);
  addGrant({ kind: 'pane', id: '%4', windowId: '@1', sessionId: '$0' }, TEST_SERVER);
  addGrant({ kind: 'window', id: '@2', windowId: '@2', sessionId: '$0' }, TEST_SERVER);

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
  addGrant({ kind: 'window', id: '@2', windowId: '@2', sessionId: '$0' }, TEST_SERVER);
  assert.equal(await isInScope('@2', 'window'), true);
  assert.equal(await isInScope('@3', 'window'), false);
  assert.equal(await isInScope('$0', 'session'), true);
  assert.equal(await isInScope('$1', 'session'), false);
  initHumanAssigned(false);
});

test('revoking a granted pane takes the access away again', () => {
  resetGrants();
  addGrant({ kind: 'pane', id: '%3', windowId: '@1', sessionId: '$0' }, TEST_SERVER);
  assert.equal(isPaneGranted('%3', '@1'), true);

  assert.equal(revokeGrant('%3'), true, 'revoking should report that it held something');
  assert.equal(isPaneGranted('%3', '@1'), false, 'the pane should no longer be reachable');
});

test('revoking something that was never granted reports nothing was held', () => {
  resetGrants();
  assert.equal(revokeGrant('%99'), false);
});

test('grants do not outlive the tmux server they were made against', () => {
  resetGrants();
  const server = '/private/tmp/tmux-501/default:16186:1788462695';
  addGrant({ kind: 'pane', id: '%3', windowId: '@1', sessionId: '$1' }, server);
  assert.equal(isPaneGranted('%3', '@1'), true);

  // Same server, asked again: nothing to do.
  assert.deepEqual(bindGrantsToServer(server), []);
  assert.equal(isPaneGranted('%3', '@1'), true);

  // A restarted server hands the same numbers out again, so %3 is no longer
  // the pane a human gave us.
  assert.deepEqual(bindGrantsToServer('/private/tmp/tmux-501/default:32314:1788787955'), ['%3']);
  assert.equal(isPaneGranted('%3', '@1'), false);
  assert.equal(hasAnyGrant(), false);
});

import { assertInScope } from '../build/scope.js';
import { executeTmux, listAllPanes } from '../build/tmux.js';
import { randomUUID } from 'node:crypto';

test('a grant made against another tmux server is refused, not honoured', async () => {
  const sessionName = `tmux-mcp-fingerprint-${process.pid}-${randomUUID()}`;
  const paneId = await executeTmux(['new-session', '-d', '-s', sessionName, '-P', '-F', '#{pane_id}']);
  try {
    resetGrants();
    initScope('none');
    initHumanAssigned(true);
    // These grants were made against a server that is gone: the same id now
    // points at whatever the running server happens to call %n.
    bindGrantsToServer('/private/tmp/tmux-501/gone:1:1');
    const pane = (await listAllPanes()).find(p => p.paneId === paneId);
    addGrant({ kind: 'pane', id: paneId, windowId: pane.windowId, sessionId: pane.sessionId }, '/private/tmp/tmux-501/gone:1:1');
    assert.equal(await isInScope(paneId, 'pane'), true, 'the grant is there to be found');

    await assert.rejects(() => assertInScope(paneId, 'pane'), /tmux server/i);
    assert.equal(hasAnyGrant(), false, 'every grant refers to that dead server');
  } finally {
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});

test('a grant says which tmux server it was made on', () => {
  resetGrants();
  // No action has run yet, so nothing has bound a server: the grant itself has
  // to carry it, or a restart before the first action would keep it alive.
  addGrant({ kind: 'pane', id: '%3', windowId: '@1', sessionId: '$1' }, 'server-A');
  assert.equal(isPaneGranted('%3', '@1'), true);
  assert.deepEqual(bindGrantsToServer('server-B'), ['%3']);
  assert.equal(hasAnyGrant(), false);
});
