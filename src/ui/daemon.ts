import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { clearUiState, newToken, writeUiState } from './state.js';

export interface DaemonOptions {
  stateDir: string;
  requestsDir: string;
  /** 0 picks an ephemeral port. */
  port?: number;
  token?: string;
  version?: string;
}

export interface RunningDaemon {
  port: number;
  token: string;
  url: string;
  close(): Promise<void>;
}

export interface RouteContext {
  url: URL;
  params: Record<string, string>;
  body: unknown;
  req: IncomingMessage;
  res: ServerResponse;
  options: DaemonOptions;
}

export type Handler = (ctx: RouteContext) => Promise<unknown> | unknown;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

const routes: Route[] = [];

/** Register a route. Segments starting with ':' capture into ctx.params. */
export function registerRoute(method: string, pattern: string, handler: Handler): void {
  routes.push({ method, segments: pattern.split('/').filter(Boolean), handler });
}

/** Returned by a handler that has already written the response itself. */
export const HANDLED = Symbol('handled');

function matchRoute(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  const parts = pathname.split('/').filter(Boolean);
  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const seg = route.segments[i];
      if (seg.startsWith(':')) {
        params[seg.slice(1)] = decodeURIComponent(parts[i]);
      } else if (seg !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

/**
 * A loopback service is reachable by any page the browser loads, so a
 * hostname that resolves to 127.0.0.1 (DNS rebinding) would otherwise be
 * able to drive it. Requiring a literal loopback Host, and an Origin that
 * matches ours, closes that.
 */
function isLocalHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
    || host === '127.0.0.1' || host === 'localhost';
}

/** Static app-shell paths, served without a token (they contain no data). */
function isPublicPath(pathname: string): boolean {
  if (pathname === '/' || pathname.startsWith('/r/') || pathname.startsWith('/assets/')) return true;
  // Root-level static files (favicon, vite.svg). Never /api or /events.
  return /^\/[\w.-]+\.(?:js|css|svg|png|ico|woff2|map)$/.test(pathname);
}

function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return true; // Same-origin fetches and curl send none.
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const token = options.token ?? newToken();
  const version = options.version ?? '0.2.3';

  // Route modules register on load; importing here keeps the module graph
  // acyclic at evaluation time (they import registerRoute from this file).
  await import('./api-requests.js');
  // Before static.js: its catch-all '/:file' route would otherwise shadow
  // '/events', because the first matching route wins.
  const { startRequestsWatcher, broadcast } = await import('./events.js');
  await import('./static.js');

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const port = (server.address() as AddressInfo).port;
    if (!isLocalHost(req.headers.host, port) || !isAllowedOrigin(req.headers.origin, port)) {
      sendJson(res, 403, { error: 'forbidden host or origin' });
      return;
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, version, pid: process.pid });
      return;
    }

    // The app shell carries no data, and a browser sends neither the
    // Authorization header nor the ?t= query on subresources: requiring a
    // token here would 401 app.js and leave a dead page. Everything that
    // exposes or changes state (/api, /events) still needs the token.
    if (isPublicPath(url.pathname)) {
      const match = matchRoute(req.method ?? 'GET', url.pathname);
      if (match) {
        const result = await match.route.handler({ url, params: match.params, body: undefined, req, res, options });
        if (result === HANDLED) return;
        sendJson(res, 200, result ?? { ok: true });
        return;
      }
    }

    const auth = req.headers.authorization;
    const presented = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : url.searchParams.get('t');
    if (presented !== token) {
      sendJson(res, 401, { error: 'missing or invalid token' });
      return;
    }

    const match = matchRoute(req.method ?? 'GET', url.pathname);
    if (!match) {
      sendJson(res, 404, { error: `not found: ${url.pathname}` });
      return;
    }

    const body = req.method === 'POST' || req.method === 'PATCH' ? await readBody(req) : undefined;
    const result = await match.route.handler({ url, params: match.params, body, req, res, options });
    if (result === HANDLED) return;
    sendJson(res, 200, result ?? { ok: true });
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: any) => {
      const status = typeof error?.status === 'number' ? error.status : 500;
      if (!res.headersSent) sendJson(res, status, { error: error?.message ?? String(error) });
      else res.end();
    });
  });

  // An SSE stream never ends on its own, so close() has to destroy sockets
  // rather than wait for them.
  const openSockets = new Set<Socket>();
  server.on('connection', socket => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });

  const port = (server.address() as AddressInfo).port;
  const stopWatcher = startRequestsWatcher(options.requestsDir, broadcast);

  await writeUiState(options.stateDir, {
    pid: process.pid,
    port,
    token,
    startedAt: Date.now(),
    version,
  });

  return {
    port,
    token,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      stopWatcher();
      for (const socket of openSockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await clearUiState(options.stateDir);
    },
  };
}
