import { watch } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Answer, PaneRequest } from './requests.js';

const POLL_INTERVAL_MS = 1000;

export function resolveRequestsDir(cliValue?: string): string {
  return cliValue
    ?? process.env.TMUX_MCP_REQUESTS_DIR
    ?? join(homedir(), '.tmux-mcp', 'requests');
}

export async function ensureRequestsDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function writeRequestFile(dir: string, request: PaneRequest): Promise<void> {
  await ensureRequestsDir(dir);
  await writeFile(join(dir, `${request.id}.json`), JSON.stringify(request, null, 2), { mode: 0o600 });
}

export async function readRequestFile(dir: string, id: string): Promise<PaneRequest | null> {
  try {
    return JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8')) as PaneRequest;
  } catch {
    return null;
  }
}

export async function listRequestFiles(dir: string): Promise<PaneRequest[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const requests: PaneRequest[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const request = await readRequestFile(dir, entry.slice(0, -'.json'.length));
    if (request) requests.push(request);
  }
  return requests;
}

export async function removeRequestFiles(dir: string, id: string): Promise<void> {
  for (const suffix of ['.json', '.grant', '.deny']) {
    await rm(join(dir, `${id}${suffix}`), { force: true });
  }
}

/** Written by the `tmux-mcp grant` / `tmux-mcp deny` CLI. */
export async function writeAnswerFile(
  dir: string,
  id: string,
  answer: 'grant' | 'deny',
  body: string
): Promise<void> {
  await ensureRequestsDir(dir);
  await writeFile(join(dir, `${id}.${answer}`), body, { mode: 0o600 });
}

/**
 * Watch the requests dir for answer files. fs.watch is used when available
 * and backed by a poll, because fs.watch is unreliable on some filesystems.
 *
 * `onAnswer` returns whether the answer was accepted. A rejected answer is
 * retried on the next scan: writing an answer file is not atomic, so a scan
 * triggered by the file's creation can read it while it is still empty or
 * truncated. Giving up on the first read would strand the request until it
 * expired.
 *
 * Returns a stop function.
 */
export function startAnswerWatcher(
  dir: string,
  onAnswer: (id: string, answer: Answer) => boolean | Promise<boolean>
): () => void {
  const handled = new Set<string>();

  const scan = async (): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const isGrant = entry.endsWith('.grant');
      const isDeny = entry.endsWith('.deny');
      if (!isGrant && !isDeny) continue;
      if (handled.has(entry)) continue;
      handled.add(entry);
      let body = '';
      try {
        body = (await readFile(join(dir, entry), 'utf8')).trim();
      } catch {
        handled.delete(entry);
        continue;
      }
      // A grant names a target, so an empty body means the write is still in
      // flight. An empty deny is legitimate: a denial without a reason.
      if (isGrant && body === '') {
        handled.delete(entry);
        continue;
      }
      const id = entry.slice(0, entry.lastIndexOf('.'));
      const accepted = await (isGrant
        ? onAnswer(id, { status: 'granted', target: body, via: 'grant' })
        : onAnswer(id, { status: 'denied', reason: body || undefined, via: 'grant' }));
      if (!accepted) handled.delete(entry);
    }
  };

  void ensureRequestsDir(dir).then(() => { void scan(); });

  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(dir, () => { void scan(); });
  } catch {
    watcher = null;
  }
  const timer = setInterval(() => { void scan(); }, POLL_INTERVAL_MS);
  timer.unref?.();

  return () => {
    clearInterval(timer);
    try { watcher?.close(); } catch { /* already closed */ }
  };
}
