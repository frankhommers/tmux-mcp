import { registerRoute, type RouteContext } from './daemon.js';
import { listRequestFiles, readRequestFile, writeAnswerFile } from '../requests-dir.js';
import { liveTargets } from '../cli-grant.js';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function loadRequest(ctx: RouteContext) {
  const request = await readRequestFile(ctx.options.requestsDir, ctx.params.id);
  if (!request) throw new HttpError(404, `no pending request ${ctx.params.id}`);
  return request;
}

registerRoute('GET', '/api/requests', async ctx => {
  const requests = await listRequestFiles(ctx.options.requestsDir);
  return {
    requests: requests
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(request => ({
        id: request.id,
        reason: request.reason,
        kind: request.kind,
        createdAt: request.createdAt,
        ageSeconds: Math.round((Date.now() - request.createdAt) / 1000),
      })),
  };
});

// Computed on every call, never cached: the whole point is that a pane the
// human opens after reading the request is assignable.
registerRoute('GET', '/api/requests/:id/targets', async ctx => {
  const request = await loadRequest(ctx);
  return { targets: await liveTargets(request) };
});

registerRoute('POST', '/api/requests/:id/grant', async ctx => {
  const request = await loadRequest(ctx);
  const target = (ctx.body as { target?: unknown } | undefined)?.target;
  if (typeof target !== 'string' || target.length === 0) {
    throw new HttpError(400, 'target is required');
  }
  const targets = await liveTargets(request);
  if (!targets.some(candidate => candidate.id === target)) {
    throw new HttpError(400, `${target} cannot be assigned: it does not exist now, or it is outside the request's scope`);
  }
  await writeAnswerFile(ctx.options.requestsDir, request.id, 'grant', target);
  return { ok: true, target };
});

registerRoute('POST', '/api/requests/:id/deny', async ctx => {
  const request = await loadRequest(ctx);
  const reason = (ctx.body as { reason?: unknown } | undefined)?.reason;
  await writeAnswerFile(ctx.options.requestsDir, request.id, 'deny', typeof reason === 'string' ? reason : '');
  return { ok: true };
});
