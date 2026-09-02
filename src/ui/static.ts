import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HANDLED, registerRoute } from './daemon.js';

/**
 * The built UI, copied here from ../ui-dist by the root build. The sources
 * live in ui/ with their own toolchain, which nobody installing tmux-mcp
 * needs.
 */
const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

async function serve(relativePath: string, res: ServerResponse): Promise<typeof HANDLED> {
  // Params are single path segments, but '..' would still escape the root.
  const target = resolve(publicDir, relativePath);
  if (target !== publicDir && !target.startsWith(publicDir + '/')) {
    res.writeHead(403).end();
    return HANDLED;
  }

  let body: Buffer;
  try {
    body = await readFile(target);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return HANDLED;
  }

  // Vite fingerprints asset filenames, so they can be cached hard; the HTML
  // that names them must never be.
  const immutable = relativePath.startsWith('assets/');
  res.writeHead(200, {
    'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
    'content-length': body.byteLength,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
  });
  res.end(body);
  return HANDLED;
}

registerRoute('GET', '/', ctx => serve('index.html', ctx.res));
// Deep link from a notification: same app, opened on one request.
registerRoute('GET', '/r/:id', ctx => serve('index.html', ctx.res));
registerRoute('GET', '/assets/:file', ctx => serve(join('assets', ctx.params.file), ctx.res));
// Anything else at the root (favicon, vite.svg). Registered last so it cannot
// shadow /events.
registerRoute('GET', '/:file', ctx => serve(ctx.params.file, ctx.res));
