import { executeTmux } from "./tmux.js";

type ScopeMode = 'none' | 'session';

let scopeMode: ScopeMode = 'none';
let scopeResolved = false;
const allowedSessionIds = new Set<string>();

// Excluded pane: the pane in which the MCP server (or agent) is running.
// Detected via $TMUX_PANE. Excluded by default to prevent the agent from
// interacting with its own pane. Use --include-current-pane to disable.
let excludedPaneId: string | null = null;
let excludeSelf = true;

/**
 * Initialize scope mode. Call once at startup.
 * Does NOT detect the session yet — that happens lazily on first tool use.
 * This way the server always starts successfully (tools can be fetched, etc.).
 */
export function initScope(mode: string): void {
  if (mode !== 'none' && mode !== 'session') {
    throw new Error(`Invalid scope mode: "${mode}". Valid values: none, session`);
  }
  scopeMode = mode as ScopeMode;
}

/**
 * Lazily resolve the allowed session. Called on first tool use when scope is active.
 * Tries to detect the current tmux session from $TMUX env var.
 * If $TMUX is not set, throws a clear error at tool-use time (not at startup).
 */
async function ensureScopeResolved(): Promise<void> {
  if (scopeMode === 'none' || scopeResolved) return;

  const tmuxEnv = process.env.TMUX;
  if (!tmuxEnv) {
    throw new Error(
      'Scope "session" is active but $TMUX is not set. ' +
      'The MCP server must be running inside a tmux pane for session scoping to work.'
    );
  }

  try {
    const sessionId = await executeTmux(['display-message', '-p', '#{session_id}']);
    if (!sessionId) {
      throw new Error('Could not determine current tmux session ID.');
    }
    allowedSessionIds.add(sessionId);
    scopeResolved = true;
  } catch (error: any) {
    throw new Error(`Failed to detect tmux session for scoping: ${error.message}`);
  }
}

/**
 * Returns true if scope is active (not 'none').
 */
export function isScopeActive(): boolean {
  return scopeMode !== 'none';
}

/**
 * Check if a resource is within the allowed scope.
 * When scope is 'none', always returns true.
 * Triggers lazy session resolution on first call.
 */
export async function isInScope(id: string, type: 'pane' | 'window' | 'session'): Promise<boolean> {
  if (scopeMode === 'none') return true;

  await ensureScopeResolved();

  try {
    let sessionId: string;
    if (type === 'session') {
      sessionId = id;
    } else {
      sessionId = await executeTmux(['display-message', '-p', '-t', id, '#{session_id}']);
    }
    return allowedSessionIds.has(sessionId);
  } catch {
    return false;
  }
}

/**
 * Assert a resource is in scope. Throws if not.
 * Triggers lazy session resolution on first call.
 */
export async function assertInScope(id: string, type: 'pane' | 'window' | 'session'): Promise<void> {
  if (!(await isInScope(id, type))) {
    throw new Error(`Access denied: ${type} ${id} is not in the allowed session scope.`);
  }
}

/**
 * Add a session to the allowed set. Called after create-session.
 */
export function addAllowedSession(sessionId: string): void {
  allowedSessionIds.add(sessionId);
}

/**
 * Get the set of allowed session IDs. Used by list filtering.
 */
export function getAllowedSessionIds(): ReadonlySet<string> {
  return allowedSessionIds;
}

/**
 * Initialize the excluded-pane feature.
 * Reads $TMUX_PANE to detect the current pane.
 * When includeSelf is true, the feature is disabled.
 */
export function initExcludeSelf(includeSelf: boolean): void {
  excludeSelf = !includeSelf;
  if (excludeSelf) {
    const paneEnv = process.env.TMUX_PANE;
    excludedPaneId = paneEnv || null;
  } else {
    excludedPaneId = null;
  }
}

/**
 * Check if a pane ID is the excluded (self) pane.
 * Returns true if the pane should be excluded.
 */
export function isExcludedPane(paneId: string): boolean {
  if (!excludeSelf || !excludedPaneId) return false;
  return paneId === excludedPaneId;
}

/**
 * Get the excluded pane ID (if any). Used for informational purposes.
 */
export function getExcludedPaneId(): string | null {
  return excludedPaneId;
}
