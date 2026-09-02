import { randomBytes } from 'node:crypto';
import type { GrantKind } from './grants.js';
import { isPaneGranted, isWindowGranted } from './grants.js';
import { listAllPanes, getPaneLocation, executeTmux } from './tmux.js';
import {
  isExcludedPane,
  getScopeMode,
  getAllowedSessionIds,
  getAllowedWindowId,
  getExcludedPaneId,
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
  | {
      status: 'granted';
      target: string;
      via: string;
      /** Filled in by answerRequest() once the target has been resolved. */
      windowId?: string;
      sessionId?: string;
    }
  | { status: 'denied'; reason?: string; via: string };

/**
 * Where a target lives, or why it may not be assigned.
 *
 * The candidate list is a snapshot taken when the agent asked, and a human
 * often opens the pane they want to hand over *after* reading the request.
 * So the list is advisory only: authorisation happens here, against the
 * situation at the moment of answering.
 */
export type TargetResolution =
  | { ok: true; windowId: string; sessionId: string }
  | { ok: false; reason: string };

export type TargetResolver = (target: string, kind: GrantKind) => Promise<TargetResolution>;

/**
 * The static scope in force when the request was made, written into the
 * request file so the `tmux-mcp requests` CLI — a separate process that
 * cannot see the server's scope — can list and validate live targets the
 * same way the server does.
 */
export interface RequestScope {
  mode: 'none' | 'session' | 'window';
  sessionIds: string[];
  windowId: string | null;
  excludedPaneId: string | null;
}

export interface PaneRequest {
  id: string;
  reason: string;
  kind: GrantKind;
  /** Advisory snapshot of what existed when the agent asked. */
  candidates: Candidate[];
  scope: RequestScope;
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
const settledListeners: Array<(id: string, answer: Answer, request: PaneRequest) => void> = [];

/**
 * Resolve a target against live tmux state and the static scope. A pane or
 * window that exists now and sits inside --scope may be assigned, whether or
 * not it existed when the request was created.
 */
export const resolveTargetLive: TargetResolver = async (target, kind) => {
  if (isScopeActive()) await ensureScopeResolved();

  if (kind === 'pane' && isExcludedPane(target)) {
    return { ok: false, reason: `${target} is the server's own pane` };
  }

  let windowId: string;
  let sessionId: string;
  try {
    if (kind === 'pane') {
      ({ windowId, sessionId } = await getPaneLocation(target));
    } else {
      windowId = target;
      sessionId = await executeTmux(['display-message', '-p', '-t', target, '#{session_id}']);
    }
  } catch {
    return { ok: false, reason: `${kind} ${target} does not exist` };
  }
  if (!windowId || !sessionId) {
    return { ok: false, reason: `${kind} ${target} does not exist` };
  }
  // A window id must resolve to itself; 'display-message -t %3' on a pane id
  // would otherwise let a pane through as a window grant.
  if (kind === 'window') {
    const resolved = await executeTmux(['display-message', '-p', '-t', target, '#{window_id}']).catch(() => '');
    if (resolved !== target) {
      return { ok: false, reason: `${target} is not a window id` };
    }
  }
  if (!isInStaticScopeForCandidate(windowId, sessionId)) {
    return { ok: false, reason: `${kind} ${target} is outside the allowed scope` };
  }
  return { ok: true, windowId, sessionId };
};

let targetResolver: TargetResolver = resolveTargetLive;

/** Test seam: replace the live tmux lookup. Reset by resetRequests(). */
export function setTargetResolver(resolver: TargetResolver): void {
  targetResolver = resolver;
}

/** Why the last answer was refused, for reporting back to the human. */
let lastRefusal: string | null = null;

export function getLastRefusal(): string | null {
  return lastRefusal;
}

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
    scope: {
      mode: getScopeMode(),
      sessionIds: [...getAllowedSessionIds()],
      windowId: getAllowedWindowId(),
      excludedPaneId: getExcludedPaneId(),
    },
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
 * answered, or the target cannot be assigned right now — the request then
 * stays pending so another channel (or a corrected grant) can answer it.
 */
export async function answerRequest(id: string, answer: Answer): Promise<boolean> {
  const entry = requests.get(id);
  if (!entry || entry.answer) return false;

  let settled: Answer = answer;
  if (answer.status === 'granted') {
    const resolution = await targetResolver(answer.target, entry.request.kind);
    if (!resolution.ok) {
      lastRefusal = resolution.reason;
      return false;
    }
    settled = { ...answer, windowId: resolution.windowId, sessionId: resolution.sessionId };
  }
  lastRefusal = null;

  // Re-check: awaiting the resolver above yields, so another channel may have
  // answered in the meantime.
  if (entry.answer) return false;

  entry.answer = settled;
  for (const waiter of entry.waiters) waiter(settled);
  entry.waiters.length = 0;
  for (const listener of settledListeners) {
    try { listener(id, settled, entry.request); } catch { /* listener errors are not fatal */ }
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
export function onRequestSettled(listener: (id: string, answer: Answer, request: PaneRequest) => void): void {
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
  targetResolver = resolveTargetLive;
  lastRefusal = null;
}
