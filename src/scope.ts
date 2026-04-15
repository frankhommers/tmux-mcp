import { executeTmux } from "./tmux.js";

type ScopeMode = 'none' | 'session' | 'window';

let scopeMode: ScopeMode = 'none';
const allowedSessionIds = new Set<string>();
let allowedWindowId: string | null = null;

// Excluded pane: the pane in which the MCP server (or agent) is running.
// Detected via $TMUX_PANE. Excluded by default to prevent the agent from
// interacting with its own pane. Use --include-current-pane to disable.
let excludedPaneId: string | null = null;
let excludeSelf = true;

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

  // Both 'session' and 'window' need session resolution
  const tmuxEnv = process.env.TMUX;
  if (!tmuxEnv) {
    throw new Error(
      `Scope "${scopeMode}" is active but $TMUX is not set. ` +
      'The MCP server must be running inside a tmux pane for scoping to work.'
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

  // 'window' additionally needs window resolution
  if (scopeMode === 'window') {
    const paneEnv = process.env.TMUX_PANE;
    if (!paneEnv) {
      throw new Error(
        'Scope "window" is active but $TMUX_PANE is not set. ' +
        'The MCP server must be running inside a tmux pane for window scoping to work.'
      );
    }

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
  return scopeMode !== 'none';
}

/**
 * Check if a resource is within the allowed scope.
 * When scope is 'none', always returns true.
 * When scope is 'session', checks session membership.
 * When scope is 'window', checks window membership for panes/windows,
 * and session membership for sessions.
 */
export async function isInScope(id: string, type: 'pane' | 'window' | 'session'): Promise<boolean> {
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
