/**
 * Human-assigned grants.
 *
 * In --human-assigned mode the agent starts with access to nothing. Every
 * pane or window it may touch was handed to it by a human, and lands here.
 * This module is pure state: no tmux calls, no I/O.
 */

export type GrantKind = 'pane' | 'window';

export interface GrantRecord {
  kind: GrantKind;
  /** Pane id (%3) for kind 'pane', window id (@2) for kind 'window'. */
  id: string;
  /** Window the resource lives in (equals `id` for kind 'window'). */
  windowId: string;
  sessionId: string;
  /** When the human handed it over. Set by addGrant when absent. */
  since?: number;
}

const grants = new Map<string, GrantRecord>();

/**
 * The tmux server these grants were made against, as `socket:pid:start_time`.
 *
 * A pane id only means something inside one server instance: a restarted
 * server hands the same numbers out again, so a grant made against the old one
 * would silently come to point at a pane no human ever gave us.
 */
let servedBy: string | null = null;

/**
 * Say which tmux server we are talking to. Returns the ids dropped because it
 * is not the one the grants were made against; binding for the first time
 * keeps everything, since that is the server they came from.
 */
export function bindGrantsToServer(fingerprint: string): string[] {
  if (servedBy === fingerprint) return [];
  const dropped = servedBy === null ? [] : [...grants.keys()];
  if (servedBy !== null) grants.clear();
  servedBy = fingerprint;
  return dropped;
}

/**
 * Record a grant, saying which tmux server it was made on. The server is not
 * optional: a grant added before one was known would otherwise be adopted by
 * whichever server happened to be running at the first action.
 */
export function addGrant(record: GrantRecord, fingerprint: string): void {
  bindGrantsToServer(fingerprint);
  grants.set(record.id, { since: Date.now(), ...record });
}

export function isPaneGranted(paneId: string, windowId: string): boolean {
  if (grants.get(paneId)?.kind === 'pane') return true;
  return isWindowGranted(windowId);
}

export function isWindowGranted(windowId: string): boolean {
  return grants.get(windowId)?.kind === 'window';
}

/**
 * True when a window should appear in listings: either it was granted whole,
 * or it holds a granted pane. Listings show the path to what you were given;
 * access to the window itself still requires isWindowGranted().
 */
export function isWindowVisible(windowId: string): boolean {
  if (isWindowGranted(windowId)) return true;
  for (const record of grants.values()) {
    if (record.windowId === windowId) return true;
  }
  return false;
}

export function isSessionGranted(sessionId: string): boolean {
  for (const record of grants.values()) {
    if (record.sessionId === sessionId) return true;
  }
  return false;
}

export function hasAnyGrant(): boolean {
  return grants.size > 0;
}

export function listGrants(): GrantRecord[] {
  return [...grants.values()];
}

/** Take a grant back. Returns whether anything was actually held. */
export function revokeGrant(id: string): boolean {
  return grants.delete(id);
}

/**
 * Drop grants whose resource has disappeared (pane closed, window killed).
 * Returns the ids that were removed.
 */
export function pruneGrants(
  livePaneIds: ReadonlySet<string>,
  liveWindowIds: ReadonlySet<string>
): string[] {
  const removed: string[] = [];
  for (const [id, record] of grants) {
    const alive = record.kind === 'pane' ? livePaneIds.has(id) : liveWindowIds.has(id);
    if (!alive) {
      grants.delete(id);
      removed.push(id);
    }
  }
  return removed;
}

/** Test helper: forget every grant. */
export function resetGrants(): void {
  grants.clear();
  servedBy = null;
}
