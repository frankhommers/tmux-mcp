import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { executeTmux } from './build/tmux.js';

const BASE = 'http://127.0.0.1:7676';
const password = (await readFile('/Users/frankhommers/Repos/tmux-dispatch/.env', 'utf8')).match(/^ADMIN_PASSWORD=(.+)$/m)[1].trim();
const login = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const get = async p => (await fetch(`${BASE}${p}`, { headers: { cookie } })).json();
const token = JSON.parse(await readFile(`${process.env.HOME}/.tmux-mcp/credentials.json`, 'utf8')).tokens[BASE];

const session = `probe-${randomUUID().slice(0, 6)}`;
const pane = await executeTmux(['new-session', '-d', '-s', session, '-P', '-F', '#{pane_id}']);
const client = new Client({ name: 'probe', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['build/index.js', '--human-assigned', '--dispatch-url=ws://127.0.0.1:7676/agent', `--dispatch-token=${token}`],
  cwd: process.cwd(), stderr: 'pipe',
});
client.setNotificationHandler(LoggingMessageNotificationSchema, n => console.log('[log]', n.params.level, JSON.stringify(n.params.data).slice(0, 200)));
await client.connect(transport);
transport.stderr?.on('data', d => process.stderr.write(`[mcp] ${d}`));
try {
  const pending = client.callTool({ name: 'request-pane', arguments: { reason: 'probe activity', timeoutSeconds: 30 } });
  let request = null;
  for (let i = 0; i < 60 && !request; i++) { await new Promise(r => setTimeout(r, 250)); request = (await get('/api/requests')).requests?.[0] ?? null; }
  await fetch(`${BASE}/api/requests/${request.id}/grant`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ target: pane }) });
  console.log('granted:', (await pending).content[0].text.split('\n')[0]);

  if (process.env.WAIT) await new Promise(r => setTimeout(r, Number(process.env.WAIT)));
  const cap = await client.callTool({ name: 'capture-pane', arguments: { paneId: pane } });
  console.log('capture isError:', cap.isError === true, '|', cap.content[0].text.slice(0, 60).replace(/\n/g, ' '));

  await new Promise(r => setTimeout(r, 500));
  const mine = (await get('/api/requests')).agents.find(a => a.identity.pid === Number(process.env.MCPPID ?? 0)) ?? (await get('/api/requests')).agents.find(a => a.grants.some(g => g.target === pane));
  console.log('lastActivity:', mine?.grants.find(g => g.target === pane)?.lastActivity ?? null);
} finally {
  await transport.close();
  await executeTmux(['kill-session', '-t', session]).catch(() => {});
}
