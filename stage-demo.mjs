import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { executeTmux } from '/Users/frankhommers/Repos/tmux-mcp/build/tmux.js';

const BASE = 'http://127.0.0.1:7676';
const password = (await readFile('/Users/frankhommers/Repos/tmux-dispatch/.env', 'utf8'))
  .match(/^ADMIN_PASSWORD=(.+)$/m)[1].trim();
const login = await fetch(`${BASE}/api/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
});
const cookie = login.headers.get('set-cookie').split(';')[0];
const token = JSON.parse(await readFile(`${process.env.HOME}/.tmux-mcp/credentials.json`, 'utf8')).tokens[BASE];

const session = `demo-${randomUUID().slice(0, 6)}`;
const pane = await executeTmux(['new-session', '-d', '-s', session, '-P', '-F', '#{pane_id}']);
const client = new Client({ name: 'stage', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['build/index.js', '--human-assigned', '--dispatch-url=ws://127.0.0.1:7676/agent', `--dispatch-token=${token}`],
  cwd: '/Users/frankhommers/Repos/tmux-mcp',
  stderr: 'pipe',
});
await client.connect(transport);
const pending = client.callTool({ name: 'request-pane', arguments: { reason: 'write the release notes', timeoutSeconds: 45 } });

let request = null;
for (let i = 0; i < 60 && !request; i++) {
  await new Promise(r => setTimeout(r, 250));
  request = (await (await fetch(`${BASE}/api/requests`, { headers: { cookie } })).json()).requests?.[0] ?? null;
}
await fetch(`${BASE}/api/requests/${request.id}/grant`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ target: pane }),
});
await pending;
await client.callTool({ name: 'capture-pane', arguments: { paneId: pane } });
console.log(`staged: ${pane} in ${session}, used just now`);

process.on('SIGTERM', async () => {
  await transport.close();
  await executeTmux(['kill-session', '-t', session]).catch(() => {});
  process.exit(0);
});
await new Promise(r => setTimeout(r, 600_000));
