import { watch } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { HANDLED, registerRoute } from './daemon.js';
import { listRequestFiles } from '../requests-dir.js';

const POLL_INTERVAL_MS = 1000;

interface Subscriber {
  res: ServerResponse;
}

const subscribers = new Set<Subscriber>();

export function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const sub of subscribers) {
    try { sub.res.write(payload); } catch { /* dropped on close below */ }
  }
}

/**
 * Watch the requests directory and emit request-added / request-answered.
 * fs.watch is unreliable on some filesystems, so it only nudges a scan that
 * a timer would run anyway.
 */
export function startRequestsWatcher(
  requestsDir: string,
  emit: (event: string, data: unknown) => void
): () => void {
  let known = new Set<string>();
  let primed = false;

  const scan = async (): Promise<void> => {
    const requests = await listRequestFiles(requestsDir);
    const current = new Set(requests.map(r => r.id));

    if (!primed) {
      // Requests already pending at startup are not news.
      known = current;
      primed = true;
      return;
    }
    for (const request of requests) {
      if (!known.has(request.id)) {
        emit('request-added', {
          id: request.id,
          reason: request.reason,
          kind: request.kind,
          createdAt: request.createdAt,
        });
      }
    }
    for (const id of known) {
      if (!current.has(id)) emit('request-answered', { id });
    }
    known = current;
  };

  void scan();

  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(requestsDir, () => { void scan(); });
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

registerRoute('GET', '/events', ctx => {
  ctx.res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  ctx.res.write(': connected\n\n');

  const sub: Subscriber = { res: ctx.res };
  subscribers.add(sub);
  ctx.req.on('close', () => { subscribers.delete(sub); });

  return HANDLED;
});
