import { executeTmux } from "./tmux.js";

type ScopeMode = 'none' | 'session';

let scopeMode: ScopeMode = 'none';
const allowedSessionIds = new Set<string>();

/**
 * Initialize scope. Call once at startup.
 * When mode is 'session', detects the current tmux session from $TMUX env var.
 * Throws if mode is 'session' but no session can be detected.
 */
export async function initScope(mode: string): Promise<void> {
  if (mode !== 'none' && mode !== 'session') {
    throw new Error(`Invalid scope mode: "${mode}". Valid values: none, session`);
  }
  scopeMode = mode as ScopeMode;

  if (scopeMode === 'none') return;

  const tmuxEnv = process.env.TMUX;
  if (!tmuxEnv) {
    throw new Error(
      'Scope "session" requires running inside tmux, but $TMUX is not set. ' +
      'Either run the MCP server inside a tmux pane, or use --scope=none.'
    );
  }

  try {
    const sessionId = await executeTmux(['display-message', '-p', '#{session_id}']);
    if (!sessionId) {
      throw new Error('Could not determine current tmux session ID.');
    }
    allowedSessionIds.add(sessionId);
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
 */
export async function isInScope(id: string, type: 'pane' | 'window' | 'session'): Promise<boolean> {
  if (scopeMode === 'none') return true;

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
