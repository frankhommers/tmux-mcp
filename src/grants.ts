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
}

const grants = new Map<string, GrantRecord>();

export function addGrant(record: GrantRecord): void {
  grants.set(record.id, record);
}

export function isPaneGranted(paneId: string, windowId: string): boolean {
  if (grants.get(paneId)?.kind === 'pane') return true;
  return isWindowGranted(windowId);
}

export function isWindowGranted(windowId: string): boolean {
  return grants.get(windowId)?.kind === 'window';
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
}
