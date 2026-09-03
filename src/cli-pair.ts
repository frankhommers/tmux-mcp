import { parseArgs } from 'node:util';
import { credentialsPath, defaultDeviceName, storeToken } from './credentials.js';

/**
 * `tmux-mcp dispatch-login` — device-code pairing.
 *
 * The machine asks for a code, prints it, and waits while a human confirms it
 * in a browser they are already signed into. No secret is ever pasted by hand.
 */

export function isPairCliCommand(value: string | undefined): value is 'dispatch-login' {
  return value === 'dispatch-login';
}

function httpBase(url: string): string {
  return url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/agent\/?$/, '').replace(/\/$/, '');
}

export async function runPairCli(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      url: { type: 'string' },
      name: { type: 'string' },
      'state-dir': { type: 'string' },
    },
  });

  const rawUrl = (values.url as string | undefined) ?? process.env.TMUX_MCP_DISPATCH_URL;
  if (!rawUrl) {
    console.error('Usage: tmux-mcp dispatch-login --url https://tmux.example.com');
    return 1;
  }
  const base = httpBase(rawUrl);
  const name = (values.name as string | undefined) ?? defaultDeviceName();
  const path = credentialsPath(values['state-dir'] as string | undefined);

  let start: { userCode: string; deviceCode: string; verificationUri: string; intervalSeconds: number; expiresInSeconds: number };
  try {
    const res = await fetch(`${base}/api/pair/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`the dispatch service answered ${res.status}`);
    start = await res.json() as typeof start;
  } catch (error) {
    console.error(`Could not reach ${base}: ${(error as Error).message}`);
    return 1;
  }

  console.log(`Open ${start.verificationUri} and enter: ${start.userCode}`);
  console.log('Waiting…');

  const deadline = Date.now() + start.expiresInSeconds * 1000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, start.intervalSeconds * 1000));
    try {
      const res = await fetch(`${base}/api/pair/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: start.deviceCode }),
        signal: AbortSignal.timeout(10_000),
      });
      const claim = await res.json() as { status?: string; token?: string };
      if (claim.status === 'ready' && claim.token) {
        await storeToken(base, claim.token, path);
        console.log(`Paired as "${name}". Token stored in ${path}`);
        console.log(`Start the server with: --dispatch-url=${rawUrl.includes('/agent') ? rawUrl : `${base.replace(/^http/, 'ws')}/agent`}`);
        return 0;
      }
      if (claim.status === 'denied') {
        console.error('The request was denied in the browser.');
        return 1;
      }
    } catch {
      // A hiccup while polling is not a failure; keep waiting.
    }
  }

  console.error('The code expired before it was confirmed.');
  return 1;
}
