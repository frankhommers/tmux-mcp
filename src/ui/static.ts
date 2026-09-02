import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HANDLED, registerRoute } from './daemon.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

async function serve(file: string, res: ServerResponse): Promise<typeof HANDLED> {
  const ext = file.slice(file.lastIndexOf('.'));
  const body = await readFile(join(publicDir, file));
  res.writeHead(200, {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
  });
  res.end(body);
  return HANDLED;
}

registerRoute('GET', '/', ctx => serve('index.html', ctx.res));
// Deep link from a notification: same page, scrolled to one request.
registerRoute('GET', '/r/:id', ctx => serve('index.html', ctx.res));
registerRoute('GET', '/app.css', ctx => serve('app.css', ctx.res));
registerRoute('GET', '/app.js', ctx => serve('app.js', ctx.res));
