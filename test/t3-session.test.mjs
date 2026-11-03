import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { resolveT3ThreadId } from '../build/t3-session.js';

/**
 * A stand-in for T3 Code's MCP endpoint: answers initialize, swallows the
 * initialized notification, and answers t3_thread_list. Records every request
 * so a test can check what left this process (the token must, the thread id
 * question must, and nothing else).
 */
async function withFakeT3(behaviour, run) {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw);
      requests.push({ headers: request.headers, body });
      if (body.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      behaviour(body, response);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
  try {
    await run({ endpoint, requests });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const json = (response, payload) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
};

const answerInitialize = (body, response) =>
  json(response, { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 't3', version: '0' } } });

test('T3CODE_THREAD_ID wins without touching the network', async () => {
  const threadId = await resolveT3ThreadId({
    env: {
      T3CODE_THREAD_ID: ' thread-7 ',
      T3_ACP_MCP_ENDPOINT: 'http://127.0.0.1:1/mcp',
      T3_ACP_MCP_AUTHORIZATION: 'Bearer secret',
    },
    fetchImpl: () => { throw new Error('must not dial'); },
  });
  assert.equal(threadId, 'thread-7');
});

test('without any T3 variables there is no session id', async () => {
  assert.equal(await resolveT3ThreadId({ env: {} }), undefined);
  assert.equal(await resolveT3ThreadId({ env: { T3_ACP_MCP_ENDPOINT: 'http://x/mcp' } }), undefined);
});

test('the per-thread token is traded for the thread id', async () => {
  await withFakeT3((body, response) => {
    if (body.method === 'initialize') return answerInitialize(body, response);
    assert.equal(body.method, 'tools/call');
    assert.deepEqual(body.params, { name: 't3_thread_list', arguments: { limit: 1 } });
    json(response, { jsonrpc: '2.0', id: body.id, result: { structuredContent: { currentThreadId: 'thread-acp-1' }, content: [] } });
  }, async ({ endpoint, requests }) => {
    const threadId = await resolveT3ThreadId({
      env: { T3_ACP_MCP_ENDPOINT: endpoint, T3_ACP_MCP_AUTHORIZATION: 'Bearer per-thread-token' },
    });
    assert.equal(threadId, 'thread-acp-1');
    assert.equal(requests.length, 3, 'initialize, initialized, one tool call');
    for (const { headers } of requests) {
      assert.equal(headers.authorization, 'Bearer per-thread-token');
    }
  });
});

test('a text block holding JSON works when structuredContent is absent', async () => {
  await withFakeT3((body, response) => {
    if (body.method === 'initialize') return answerInitialize(body, response);
    json(response, {
      jsonrpc: '2.0', id: body.id,
      result: { content: [{ type: 'text', text: JSON.stringify({ currentThreadId: 'thread-acp-2', threads: [] }) }] },
    });
  }, async ({ endpoint }) => {
    const threadId = await resolveT3ThreadId({
      env: { T3_ACP_MCP_ENDPOINT: endpoint, T3_ACP_MCP_AUTHORIZATION: 'Bearer t' },
    });
    assert.equal(threadId, 'thread-acp-2');
  });
});

test('an SSE answer is read like a JSON one', async () => {
  await withFakeT3((body, response) => {
    if (body.method === 'initialize') return answerInitialize(body, response);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([
      'event: message',
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { currentThreadId: 'thread-acp-3' } } })}`,
      '', '',
    ].join('\n'));
  }, async ({ endpoint }) => {
    const threadId = await resolveT3ThreadId({
      env: { T3_ACP_MCP_ENDPOINT: endpoint, T3_ACP_MCP_AUTHORIZATION: 'Bearer t' },
    });
    assert.equal(threadId, 'thread-acp-3');
  });
});

test('a refusing or dead endpoint yields no session id, with a warning', async () => {
  const warnings = [];
  await withFakeT3((body, response) => response.writeHead(401).end(), async ({ endpoint }) => {
    const threadId = await resolveT3ThreadId({
      env: { T3_ACP_MCP_ENDPOINT: endpoint, T3_ACP_MCP_AUTHORIZATION: 'Bearer wrong' },
      log: (level, message) => warnings.push(`${level}: ${message}`),
    });
    assert.equal(threadId, undefined);
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /warning: could not resolve the T3 thread/);
  assert.ok(!warnings[0].includes('Bearer'), 'the token must never be logged');

  const silent = await resolveT3ThreadId({
    env: { T3_ACP_MCP_ENDPOINT: 'http://127.0.0.1:1/mcp', T3_ACP_MCP_AUTHORIZATION: 'Bearer t' },
    timeoutMs: 500,
  });
  assert.equal(silent, undefined);
});

// The fallback is opt-in: it only runs when --session-id-env names
// T3CODE_THREAD_ID and no configured variable is set.

const { sessionIdSource } = await import('../build/t3-session.js');
const neverDial = () => { throw new Error('must not dial'); };

test('without configuration nothing is resolved, even with T3 variables around', async () => {
  const source = sessionIdSource({
    env: { T3_ACP_MCP_ENDPOINT: 'http://127.0.0.1:1/mcp', T3_ACP_MCP_AUTHORIZATION: 'Bearer t', T3CODE_THREAD_ID: 'thread-1' },
    fetchImpl: neverDial,
  });
  assert.equal(await source(), undefined);
});

test('a configured variable that is set wins without dialling', async () => {
  const source = sessionIdSource({
    envNames: 'T3CODE_THREAD_ID',
    env: { T3CODE_THREAD_ID: 'thread-1', T3_ACP_MCP_ENDPOINT: 'http://127.0.0.1:1/mcp', T3_ACP_MCP_AUTHORIZATION: 'Bearer t' },
    fetchImpl: neverDial,
  });
  assert.equal(await source(), 'thread-1');
});

test('naming another variable never falls back to the endpoint', async () => {
  const source = sessionIdSource({
    envNames: 'MY_SESSION',
    env: { T3_ACP_MCP_ENDPOINT: 'http://127.0.0.1:1/mcp', T3_ACP_MCP_AUTHORIZATION: 'Bearer t' },
    fetchImpl: neverDial,
  });
  assert.equal(await source(), undefined);
});

test('naming T3CODE_THREAD_ID without the variable asks T3, once', async () => {
  await withFakeT3((body, response) => {
    if (body.method === 'initialize') return answerInitialize(body, response);
    json(response, { jsonrpc: '2.0', id: body.id, result: { structuredContent: { currentThreadId: 'thread-acp-9' } } });
  }, async ({ endpoint, requests }) => {
    const source = sessionIdSource({
      envNames: 'T3CODE_THREAD_ID,CLAUDE_CODE_SESSION_ID',
      env: { T3_ACP_MCP_ENDPOINT: endpoint, T3_ACP_MCP_AUTHORIZATION: 'Bearer t' },
    });
    assert.equal(await source(), 'thread-acp-9');
    assert.equal(await source(), 'thread-acp-9');
    assert.equal(requests.length, 3, 'the answer is remembered, not asked again');
  });
});
