import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Device tokens, one per dispatch service.
 *
 * Kept out of the shell history and out of any config file a human edits: the
 * pairing flow writes them here, and the server reads them by URL.
 */

export interface Credentials {
  /** Keyed by dispatch's base URL, so several deployments can coexist. */
  tokens: Record<string, string>;
}

export function credentialsPath(stateDir?: string): string {
  const dir = stateDir ?? process.env.TMUX_MCP_STATE_DIR ?? join(homedir(), '.tmux-mcp');
  return join(dir, 'credentials.json');
}

/** The origin a token belongs to, so ws:// and http:// share one entry. */
export function credentialKey(url: string): string {
  try {
    const parsed = new URL(url);
    const scheme = parsed.protocol === 'wss:' || parsed.protocol === 'https:' ? 'https' : 'http';
    return `${scheme}://${parsed.host}`;
  } catch {
    return url;
  }
}

export async function readCredentials(path = credentialsPath()): Promise<Credentials> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Credentials;
    return { tokens: parsed.tokens ?? {} };
  } catch {
    return { tokens: {} };
  }
}

export async function storeToken(url: string, token: string, path = credentialsPath()): Promise<void> {
  const credentials = await readCredentials(path);
  credentials.tokens[credentialKey(url)] = token;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function tokenFor(url: string, path = credentialsPath()): Promise<string | undefined> {
  return (await readCredentials(path)).tokens[credentialKey(url)];
}

export function defaultDeviceName(): string {
  return hostname();
}
