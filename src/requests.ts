import { randomBytes } from 'node:crypto';
import type { GrantKind } from './grants.js';
import { isPaneGranted, isWindowGranted } from './grants.js';
import { listAllPanes } from './tmux.js';
import {
  isExcludedPane,
  getScopeMode,
  getAllowedSessionIds,
  getAllowedWindowId,
  isScopeActive,
  ensureScopeResolved,
} from './scope.js';

export interface Candidate {
  id: string;
  /** Human-readable one-liner shown in prompts. */
  label: string;
  windowId: string;
  sessionId: string;
}

export type Answer =
  | { status: 'granted'; target: string; via: string }
  | { status: 'denied'; reason?: string; via: string };

export interface PaneRequest {
  id: string;
  reason: string;
  kind: GrantKind;
  candidates: Candidate[];
  createdAt: number;
}

interface RequestEntry {
  request: PaneRequest;
  /** null while pending. Settled entries are kept until they expire, so an
   *  answer that races ahead of waitForAnswer() is not lost. */
  answer: Answer | null;
  waiters: Array<(answer: Answer) => void>;
}

const requests = new Map<string, RequestEntry>();
const settledListeners: Array<(id: string, answer: Answer) => void> = [];

/**
 * Build the list of resources a human may pick from: everything inside the
 * static scope, minus the server's own pane and anything already granted.
 * The agent never sees this list — only the item it was given.
 */
export async function buildCandidates(kind: GrantKind): Promise<Candidate[]> {
  if (isScopeActive()) await ensureScopeResolved();

  const panes = await listAllPanes();
  const candidates: Candidate[] = [];
  const seenWindows = new Set<string>();

  for (const pane of panes) {
    if (isExcludedPane(pane.paneId)) continue;
    if (!isInStaticScopeForCandidate(pane.windowId, pane.sessionId)) continue;

    if (kind === 'pane') {
      if (isPaneGranted(pane.paneId, pane.windowId)) continue;
      candidates.push({
        id: pane.paneId,
        label: `${pane.paneId}  ${pane.sessionName}:${pane.windowName}.${pane.paneIndex}  ${pane.currentCommand}  "${pane.title}"`,
        windowId: pane.windowId,
        sessionId: pane.sessionId,
      });
    } else {
      if (seenWindows.has(pane.windowId)) continue;
      seenWindows.add(pane.windowId);
      if (isWindowGranted(pane.windowId)) continue;
      candidates.push({
        id: pane.windowId,
        label: `${pane.windowId}  ${pane.sessionName}:${pane.windowName}`,
        windowId: pane.windowId,
        sessionId: pane.sessionId,
      });
    }
  }
  return candidates;
}

/**
 * Static-scope check for a candidate. isInScope() would also apply the grant
 * filter (which is exactly what a candidate has not passed yet), so check the
 * enclosing window/session directly — grants never widen those.
 */
function isInStaticScopeForCandidate(windowId: string, sessionId: string): boolean {
  const mode = getScopeMode();
  if (mode === 'none') return true;
  if (mode === 'session') return getAllowedSessionIds().has(sessionId);
  return getAllowedWindowId() === windowId;
}

export function createRequest(reason: string, kind: GrantKind, candidates: Candidate[]): PaneRequest {
  const request: PaneRequest = {
    id: `r-${randomBytes(4).toString('hex')}`,
    reason,
    kind,
    candidates,
    createdAt: Date.now(),
  };
  requests.set(request.id, { request, answer: null, waiters: [] });
  return request;
}

export function getRequest(id: string): PaneRequest | undefined {
  return requests.get(id)?.request;
}

/**
 * Record an answer. Returns false when the request is unknown, already
 * answered, or the target is not one of the offered candidates — the request
 * then stays pending so another channel (or a corrected grant) can answer it.
 */
export function answerRequest(id: string, answer: Answer): boolean {
  const entry = requests.get(id);
  if (!entry || entry.answer) return false;
  if (answer.status === 'granted' && !entry.request.candidates.some(c => c.id === answer.target)) {
    return false;
  }
  entry.answer = answer;
  for (const waiter of entry.waiters) waiter(answer);
  entry.waiters.length = 0;
  for (const listener of settledListeners) {
    try { listener(id, answer); } catch { /* listener errors are not fatal */ }
  }
  return true;
}

/** Resolves with the answer, or null when the timeout elapses first. */
export function waitForAnswer(id: string, timeoutMs: number): Promise<Answer | null> {
  const entry = requests.get(id);
  if (!entry) return Promise.resolve(null);
  if (entry.answer) return Promise.resolve(entry.answer);
  return new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(null);
    }, timeoutMs);
    entry.waiters.push(answer => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(answer);
    });
  });
}

/** Called whenever a request is answered, by any channel. */
export function onRequestSettled(listener: (id: string, answer: Answer) => void): void {
  settledListeners.push(listener);
}

/** Drop requests older than maxAgeMs. Returns the ids removed. */
export function expireRequests(maxAgeMs: number): string[] {
  const now = Date.now();
  const expired: string[] = [];
  for (const [id, entry] of requests) {
    if (now - entry.request.createdAt > maxAgeMs) {
      requests.delete(id);
      expired.push(id);
    }
  }
  return expired;
}

/** Requests still waiting for an answer. */
export function listPendingRequests(): PaneRequest[] {
  return [...requests.values()].filter(e => e.answer === null).map(e => e.request);
}

/** True when the request exists and nobody has answered it yet. */
export function isPending(id: string): boolean {
  const entry = requests.get(id);
  return entry !== undefined && entry.answer === null;
}

/** Test helper. */
export function resetRequests(): void {
  requests.clear();
  settledListeners.length = 0;
}
