/**
 * T3 Code support: which agent thread is this server serving?
 *
 * T3 gives the Claude sessions it runs the thread id directly, as
 * T3CODE_THREAD_ID in the environment. Agents that run over ACP do not get
 * that variable yet (pingdotgg/t3code#30361); they get a per-thread MCP
 * endpoint and bearer token instead (T3_ACP_MCP_ENDPOINT / _AUTHORIZATION).
 * T3 knows which thread that token belongs to, so this module asks it: the
 * t3_thread_list tool answers with currentThreadId, the asking thread's own
 * id. Once T3 sets the variable for ACP agents too, the variable is found
 * and the endpoint is never dialled.
 *
 * None of this runs unasked. Only when the user configured
 * `--session-id-env=T3CODE_THREAD_ID` and the variable is absent does the
 * server fall back to asking T3; without that configuration there is no
 * session id. The token is a secret with real power over the thread. It
 * never leaves this process and is never logged; only the thread id, which
 * is not a secret, is reported onwards.
 */

/** The variable T3 sets; naming it in --session-id-env opts into the fallback. */
export const T3_THREAD_ENV = 'T3CODE_THREAD_ID';

/**
 * How the server learns which agent session it serves. Explicit configuration
 * wins. The T3 endpoint is asked at most once per process, and only when the
 * configured variables name T3CODE_THREAD_ID and none of them is set.
 */
export function sessionIdSource(
  options: SessionIdSource & Omit<T3SessionOptions, 'env'>,
): () => Promise<string | undefined> {
  const configured = resolveSessionId(options);
  if (configured !== undefined) return async () => configured;
  if (!envNameList(options.envNames, options.env).includes(T3_THREAD_ENV)) {
    return async () => undefined;
  }
  let asked: Promise<string | undefined> | null = null;
  return () => (asked ??= resolveT3ThreadId(options));
}

import { envNameList, resolveSessionId, sanitizeSessionId, type SessionIdSource } from './session-id.js';

export interface T3SessionOptions {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  log?: (level: 'info' | 'warning', message: string) => void;
  /** Per HTTP request. The endpoint is loopback, so slow means broken. */
  timeoutMs?: number;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

const TIMEOUT_MS = 3000;

export async function resolveT3ThreadId(options: T3SessionOptions): Promise<string | undefined> {
  const direct = sanitizeSessionId(options.env.T3CODE_THREAD_ID);
  if (direct) return direct;

  const endpoint = options.env.T3_ACP_MCP_ENDPOINT;
  const authorization = options.env.T3_ACP_MCP_AUTHORIZATION;
  if (!endpoint || !authorization) return undefined;

  try {
    const threadId = await askT3(endpoint, authorization, options);
    if (threadId) {
      options.log?.('info', `session resolved from T3: thread ${threadId}`);
      return threadId;
    }
    options.log?.('warning', 'T3 did not name the calling thread');
    return undefined;
  } catch (error) {
    options.log?.('warning', `could not resolve the T3 thread: ${(error as Error).message}`);
    return undefined;
  }
}

/** Three MCP calls over streamable HTTP: initialize, initialized, one tool. */
async function askT3(
  endpoint: string,
  authorization: string,
  options: T3SessionOptions,
): Promise<string | undefined> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  let mcpSession: string | undefined;

  const rpc = async (body: Record<string, unknown>): Promise<any> => {
    const response = await doFetch(endpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(mcpSession ? { 'mcp-session-id': mcpSession } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    mcpSession = response.headers.get('mcp-session-id') ?? mcpSession;
    if (!response.ok) throw new Error(`T3 answered ${response.status}`);
    if (body.id === undefined) return undefined; // a notification expects no reply

    // The server may answer as plain JSON or as an SSE stream; accept both.
    if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      for (const event of (await response.text()).split('\n\n')) {
        const data = event
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trim())
          .join('\n');
        if (!data) continue;
        const message = JSON.parse(data);
        if (message.id === body.id) return message;
      }
      throw new Error('no reply in the event stream');
    }
    return response.json();
  };

  await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'tmux-mcp', version: '0.0.0' },
    },
  });
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const reply = await rpc({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 't3_thread_list', arguments: { limit: 1 } },
  });

  const result = reply?.result;
  if (!result || result.isError) throw new Error('t3_thread_list failed');

  // The id sits in structuredContent, or in a text block as JSON.
  let threadId = result.structuredContent?.currentThreadId;
  if (typeof threadId !== 'string') {
    for (const block of result.content ?? []) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      try {
        const parsed = JSON.parse(block.text);
        if (typeof parsed?.currentThreadId === 'string') threadId = parsed.currentThreadId;
      } catch {
        // not JSON; keep looking
      }
    }
  }
  return sanitizeSessionId(typeof threadId === 'string' ? threadId : undefined);
}
