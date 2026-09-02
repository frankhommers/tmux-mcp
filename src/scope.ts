import { executeTmux } from "./tmux.js";
import { isPaneGranted, isWindowGranted, isSessionGranted, isWindowVisible } from "./grants.js";

type ScopeMode = 'none' | 'session' | 'window';

let scopeMode: ScopeMode = 'none';
const allowedSessionIds = new Set<string>();
let allowedWindowId: string | null = null;

// Excluded pane: the pane in which the MCP server (or agent) is running.
// Detected via $TMUX_PANE. Excluded by default to prevent the agent from
// interacting with its own pane. Use --include-current-pane to disable.
let excludedPaneId: string | null = null;
let excludeSelf = true;

// Human-assigned mode: the allowed set starts empty and only grows through
// explicit human assignment (see grants.ts). It intersects with the static
// scope above — a resource must pass both checks.
let humanAssigned = false;

export function initHumanAssigned(enabled: boolean): void {
  humanAssigned = enabled;
}

export function isHumanAssigned(): boolean {
  return humanAssigned;
}

let scopeResolved = false;

/**
 * Initialize scope mode. Call once at startup.
 * Only validates the mode value. Actual resolution of session/window IDs
 * happens lazily on first tool use, so the server always starts successfully.
 */
export function initScope(mode: string): void {
  if (mode !== 'none' && mode !== 'session' && mode !== 'window') {
    throw new Error(`Invalid scope mode: "${mode}". Valid values: none, session, window`);
  }
  scopeMode = mode as ScopeMode;
}

/**
 * Lazily resolve the allowed session (and window for 'window' mode).
 * Called on first tool use when scope is active.
 * Throws a clear error at tool-use time if env vars are missing.
 */
export async function ensureScopeResolved(): Promise<void> {
  if (scopeMode === 'none' || scopeResolved) return;

  // Both 'session' and 'window' anchor the scope on the server's OWN pane,
  // identified by $TMUX_PANE. The session/window MUST be resolved relative to
  // that pane (display-message -t "$TMUX_PANE"). Resolving without -t returns
  // tmux's ambient "current" session — the most recently active client — which
  // is NOT necessarily the pane the server runs in. With multiple attached
  // clients/agents that mismatch scopes an agent to the wrong session, so it
  // sees another agent's panes.
  const tmuxEnv = process.env.TMUX;
  if (!tmuxEnv) {
    throw new Error(
      `Scope "${scopeMode}" is active but $TMUX is not set. ` +
      'The MCP server must be running inside a tmux pane for scoping to work.'
    );
  }

  const paneEnv = process.env.TMUX_PANE;
  if (!paneEnv) {
    throw new Error(
      `Scope "${scopeMode}" is active but $TMUX_PANE is not set. ` +
      'The MCP server must be running inside a tmux pane for scoping to work.'
    );
  }

  try {
    const sessionId = await executeTmux(['display-message', '-p', '-t', paneEnv, '#{session_id}']);
    if (!sessionId) {
      throw new Error('Could not determine current tmux session ID.');
    }
    allowedSessionIds.add(sessionId);
  } catch (error: any) {
    throw new Error(`Failed to detect tmux session for scoping: ${error.message}`);
  }

  // 'window' additionally needs window resolution (also anchored on $TMUX_PANE)
  if (scopeMode === 'window') {
    try {
      const windowId = await executeTmux(['display-message', '-p', '-t', paneEnv, '#{window_id}']);
      if (!windowId) {
        throw new Error('Could not determine current tmux window ID.');
      }
      allowedWindowId = windowId;
    } catch (error: any) {
      throw new Error(`Failed to detect tmux window for scoping: ${error.message}`);
    }
  }

  scopeResolved = true;
}

/**
 * Returns true if scope is active (not 'none').
 */
export function isScopeActive(): boolean {
  return scopeMode !== 'none' || humanAssigned;
}

/**
 * Listing filter. Sessions and windows that merely contain a granted pane
 * stay visible, so the agent can see the path to what it was given, while
 * isInScope() still governs what it may act on.
 */
export async function isVisibleInScope(id: string, type: 'window' | 'session'): Promise<boolean> {
  if (!(await isInStaticScope(id, type))) return false;
  if (!humanAssigned) return true;
  return type === 'session' ? isSessionGranted(id) : isWindowVisible(id);
}

/**
 * Check if a resource is within the allowed scope.
 * When scope is 'none', always returns true.
 * When scope is 'session', checks session membership.
 * When scope is 'window', checks window membership for panes/windows,
 * and session membership for sessions.
 */
export async function isInScope(id: string, type: 'pane' | 'window' | 'session'): Promise<boolean> {
  if (!(await isInStaticScope(id, type))) return false;
  if (!humanAssigned) return true;
  return isInGrantedScope(id, type);
}

/**
 * Grant check for human-assigned mode. Runs only after the static scope has
 * already accepted the resource.
 */
async function isInGrantedScope(id: string, type: 'pane' | 'window' | 'session'): Promise<boolean> {
  try {
    if (type === 'session') return isSessionGranted(id);
    if (type === 'window') return isWindowGranted(id);
    // A pane is allowed by its own grant or by a grant on its window. Only
    // resolve the window when the cheap check did not already succeed.
    // An empty window id can never match a granted window.
    if (isPaneGranted(id, '')) return true;
    const windowId = await executeTmux(['display-message', '-p', '-t', id, '#{window_id}']);
    return isPaneGranted(id, windowId);
  } catch {
    return false;
  }
}

async function isInStaticScope(id: string, type: 'pane' | 'window' | 'session'): Promise<boolean> {
  if (scopeMode === 'none') return true;

  await ensureScopeResolved();

  try {
    if (scopeMode === 'window') {
      if (type === 'session') {
        return allowedSessionIds.has(id);
      }
      // For panes and windows, check against the allowed window
      let windowId: string;
      if (type === 'window') {
        windowId = id;
      } else {
        windowId = await executeTmux(['display-message', '-p', '-t', id, '#{window_id}']);
      }
      return windowId === allowedWindowId;
    }

    // scopeMode === 'session'
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
    const scopeLabel = scopeMode === 'window' ? 'window' : 'session';
    throw new Error(`Access denied: ${type} ${id} is not in the allowed ${scopeLabel} scope.`);
  }
}

/**
 * Returns true if scope mode is 'window'.
 */
export function isWindowScope(): boolean {
  return scopeMode === 'window';
}

/**
 * Returns the current scope mode.
 */
export function getScopeMode(): ScopeMode {
  return scopeMode;
}

/**
 * Get the set of allowed session IDs. Used by list filtering.
 */
export function getAllowedSessionIds(): ReadonlySet<string> {
  return allowedSessionIds;
}

/** The window id the static scope is anchored on, or null. */
export function getAllowedWindowId(): string | null {
  return allowedWindowId;
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

/**
 * Get the agent's own pane ID from $TMUX_PANE.
 * Unlike getExcludedPaneId(), this always returns the pane ID
 * regardless of the exclude-self setting.
 */
export function getSelfPaneId(): string | null {
  return process.env.TMUX_PANE || null;
}
