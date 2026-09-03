/**
 * End-to-end proof against the running dispatch container:
 * a real MCP server asks for a pane, the human grants it in dispatch, the
 * grant shows up, the human takes it back, and the next action is refused.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { executeTmux } from './build/tmux.js';

const BASE = 'http://127.0.0.1:7676';
const text = r => r.content[0].text;
const step = (n, m) => console.log(`\n[${n}] ${m}`);

const password = (await readFile(new URL('../../Repos/tmux-dispatch/.env', import.meta.url), 'utf8'))
  .match(/^ADMIN_PASSWORD=(.+)$/m)[1].trim();

const login = await fetch(`${BASE}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password }),
});
assert.equal(login.status, 200, 'sign in');
const cookie = login.headers.get('set-cookie').split(';')[0];
const get = async path => (await fetch(`${BASE}${path}`, { headers: { cookie } })).json();
const post = async (path, body) => fetch(`${BASE}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body ?? {}),
});

const token = JSON.parse(await readFile(`${process.env.HOME}/.tmux-mcp/credentials.json`, 'utf8')).tokens[BASE];
const session = `proof-${randomUUID().slice(0, 8)}`;
const pane = await executeTmux(['new-session', '-d', '-s', session, '-P', '-F', '#{pane_id}']);
step(1, `pane ${pane} opened in session ${session}`);

const client = new Client({ name: 'proof', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['build/index.js', '--human-assigned', `--dispatch-url=ws://127.0.0.1:7676/agent`, `--dispatch-token=${token}`],
  cwd: process.cwd(),
  stderr: 'pipe',
});
await client.connect(transport);
transport.stderr?.on('data', d => process.stderr.write(`    [mcp] ${d}`));

try {
  step(2, 'the agent asks for a pane');
  const pending = client.callTool({
    name: 'request-pane',
    arguments: { reason: 'prove take-back works', timeoutSeconds: 30 },
  });

  let request = null;
  for (let i = 0; i < 60 && !request; i++) {
    await new Promise(r => setTimeout(r, 250));
    request = (await get('/api/requests')).requests[0] ?? null;
  }
  assert.ok(request, 'the request should reach dispatch');
  console.log(`    dispatch sees: "${request.reason}" from ${request.agent.host}`);

  step(3, `the human grants ${pane}`);
  assert.equal((await post(`/api/requests/${request.id}/grant`, { target: pane })).status, 200);
  const granted = await pending;
  console.log('    ' + text(granted).split('\n').filter(Boolean).join(' | '));
  assert.match(text(granted), /^Status: granted$/m);

  step(4, 'dispatch lists it as held');
  let agent = null;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250));
    agent = (await get('/api/requests')).agents.find(a => a.grants.some(g => g.target === pane));
    if (agent) break;
  }
  assert.ok(agent, 'the grant should be listed');
  const grant = agent.grants.find(g => g.target === pane);
  console.log(`    ${agent.identity.host} holds ${grant.target}  (${grant.label})  connected=${agent.connected}`);

  step(5, 'the agent works in the pane');
  const before = await client.callTool({ name: 'capture-pane', arguments: { paneId: pane } });
  assert.ok(!before.isError, 'capture should succeed while granted');
  console.log('    capture-pane: ok');

  step(6, 'the agent goes quiet, so nothing is listening');
  let quiet = null;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250));
    quiet = (await get('/api/requests')).agents.find(a => a.id === agent.id);
    if (quiet && !quiet.connected) break;
  }
  assert.ok(quiet && !quiet.connected, 'the agent should have hung up');
  console.log(`    connected=${quiet.connected}, still holding ${quiet.grants.map(g => g.target).join(', ')}`);

  step(7, 'the human takes it back while the agent is not listening');
  assert.equal((await post(`/api/agents/${agent.id}/revoke`, { target: pane })).status, 200);
  await new Promise(r => setTimeout(r, 500));

  step(8, 'the very next action asks dispatch, and is refused');
  const after = await client.callTool({ name: 'capture-pane', arguments: { paneId: pane } });
  console.log(`    capture-pane: ${text(after).split('\n')[0]}`);
  assert.ok(after.isError, 'capture should now be refused');
  assert.match(text(after), /taken back/, 'and it should say why');

  step(9, 'dispatch no longer lists it');
  const still = (await get('/api/requests')).agents.find(a => a.grants.some(g => g.target === pane));
  assert.ok(!still, 'the grant should be gone from dispatch too');
  console.log('    gone');

  console.log('\nALLES BEWEZEN');
} finally {
  await transport.close();
  await executeTmux(['kill-session', '-t', session]).catch(() => {});
}
