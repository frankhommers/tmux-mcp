import { spawn } from 'node:child_process';
import type { Answer, PaneRequest } from './requests.js';

/**
 * Run the user's assign hook for one request.
 *
 * The hook receives the request as JSON on stdin plus TMUX_MCP_* env vars.
 * Its first line of stdout is the answer: a candidate id grants, `deny` or
 * `deny: reason` denies, empty output means it only notified the human and
 * the answer will arrive through another channel.
 *
 * Returns a function that kills the hook (used when another channel answers
 * first, or when the request expires).
 */
export function spawnAssignHook(
  hookPath: string,
  request: PaneRequest,
  requestsDir: string,
  onAnswer: (answer: Answer) => void,
  log: (level: 'info' | 'warning', message: string) => void
): () => void {
  const child = spawn(hookPath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TMUX_MCP_REQUEST_ID: request.id,
      TMUX_MCP_REASON: request.reason,
      TMUX_MCP_KIND: request.kind,
      TMUX_MCP_REQUESTS_DIR: requestsDir,
    },
  });

  const payload = {
    id: request.id,
    reason: request.reason,
    kind: request.kind,
    pid: process.pid,
    grantCommand: `tmux-mcp grant ${request.id} <target>`,
    candidates: request.candidates.map(c => ({ id: c.id, label: c.label })),
  };

  child.stdin.on('error', () => { /* hook may not read stdin */ });
  child.stdin.end(JSON.stringify(payload, null, 2));

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });

  child.on('error', error => {
    log('warning', `assign hook ${hookPath} failed to start: ${(error as Error).message}`);
  });

  child.on('close', code => {
    if (code !== 0) {
      log('warning', `assign hook exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`);
      return;
    }
    const answer = parseHookOutput(stdout, request);
    if (!answer) {
      log('info', `assign hook for ${request.id} returned no answer (notification only)`);
      return;
    }
    onAnswer(answer);
  });

  return () => {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  };
}

function parseHookOutput(stdout: string, request: PaneRequest): Answer | null {
  const line = stdout.split('\n').map(l => l.trim()).find(l => l.length > 0);
  if (!line) return null;
  if (line === 'deny') return { status: 'denied', reason: undefined, via: 'hook' };
  if (line.startsWith('deny:')) {
    const reason = line.slice('deny:'.length).trim();
    return { status: 'denied', reason: reason || undefined, via: 'hook' };
  }
  if (request.candidates.some(candidate => candidate.id === line)) {
    return { status: 'granted', target: line, via: 'hook' };
  }
  return null;
}
