import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSessionId } from '../build/session-id.js';

test('no configuration means no session id', () => {
  assert.equal(resolveSessionId({ env: { T3CODE_THREAD_ID: 'abc' } }), undefined,
    'tmux-mcp must not guess at harness-specific variables on its own');
});

test('an explicit value is used as is, trimmed', () => {
  assert.equal(resolveSessionId({ value: '  thread-1 ', env: {} }), 'thread-1');
});

test('TMUX_MCP_SESSION_ID works as the explicit value', () => {
  assert.equal(resolveSessionId({ env: { TMUX_MCP_SESSION_ID: 'from-env' } }), 'from-env');
});

test('the flag wins over TMUX_MCP_SESSION_ID', () => {
  assert.equal(resolveSessionId({ value: 'flag', env: { TMUX_MCP_SESSION_ID: 'env' } }), 'flag');
});

test('a named variable is read at runtime', () => {
  assert.equal(resolveSessionId({ envNames: 'MY_THREAD', env: { MY_THREAD: 't-42' } }), 't-42');
});

test('the first named variable that is set wins', () => {
  const env = { SECOND: 'two', THIRD: 'three' };
  assert.equal(resolveSessionId({ envNames: 'FIRST, SECOND,THIRD', env }), 'two');
});

test('TMUX_MCP_SESSION_ID_ENV names the variables when the flag is absent', () => {
  const env = { TMUX_MCP_SESSION_ID_ENV: 'MY_THREAD', MY_THREAD: 't-7' };
  assert.equal(resolveSessionId({ env }), 't-7');
});

test('an explicit value wins over named variables', () => {
  const env = { MY_THREAD: 't-1' };
  assert.equal(resolveSessionId({ value: 'pinned', envNames: 'MY_THREAD', env }), 'pinned');
});

test('empty values are skipped, and nothing set means no session id', () => {
  assert.equal(resolveSessionId({ envNames: 'A,B', env: { A: '   ', B: '' } }), undefined);
  assert.equal(resolveSessionId({ value: ' ', envNames: 'A', env: { A: 'a' } }), 'a');
});

test('an overlong id is cut, so a bad variable cannot flood the wire', () => {
  const id = resolveSessionId({ value: 'x'.repeat(1000), env: {} });
  assert.equal(id.length, 200);
});
