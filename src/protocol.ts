/**
 * The wire contract with the dispatch service, specified in docs/protocol.md.
 *
 * These types are declared again on the dispatch side. That duplication is
 * deliberate: a published package for six message shapes costs more than it
 * saves, and the two sides are deployed independently anyway, so the contract
 * has to hold at runtime. PROTOCOL_VERSION is what enforces it.
 */

/** "<major>.<minor>". Same major connects; different major refuses. */
export const PROTOCOL_VERSION = '1.6';

export function protocolMajor(version: string): string {
  return version.split('.')[0] ?? '';
}

export function isCompatible(theirs: string): boolean {
  return protocolMajor(theirs) === protocolMajor(PROTOCOL_VERSION);
}

export interface AgentIdentity {
  /**
   * Stable for the lifetime of one MCP server process, so a reconnect is
   * recognisably the same server. Grants live in that process's memory, so a
   * new id means the old grants are gone with it.
   */
  instanceId: string;
  /** The tmux server it is talking to, as `socket:pid:start_time`. */
  tmuxServer?: string;
  /** The name the MCP client gave in its `initialize` handshake, verbatim. */
  mcpClient?: string;
  pid: number;
  host: string;
  cwd: string;
  tmuxSession: string | null;
  scope: string;
  client: string;
}

export interface WireCandidate {
  id: string;
  label: string;
}

/** A resource a human has handed to this agent, as dispatch sees it. */
export interface WireGrant {
  target: string;
  kind: 'pane' | 'window';
  label: string;
  since: number;
  /** Why it was asked for. Outlives the request, which is gone once answered. */
  reason?: string;
}

export type ServerToDispatch =
  | { type: 'hello'; protocolVersion: string; agent: AgentIdentity }
  | {
      type: 'request';
      id: string;
      reason: string;
      kind: 'pane' | 'window';
      createdAt: number;
      expiresAt: number;
      candidates: WireCandidate[];
      /** A target the agent would like. A hint for the human, nothing more. */
      suggested?: string;
    }
  | { type: 'candidates'; id: string; candidates: WireCandidate[] }
  | { type: 'withdraw'; id: string; why: 'expired' | 'answered_elsewhere' | 'shutdown' }
  | { type: 'result'; id: string; ok: true; target: string }
  | { type: 'result'; id: string; ok: false; error: string }
  | { type: 'grants'; grants: WireGrant[] }
  | { type: 'inventory-changed' }
  | { type: 'validation'; id: string; tmuxServer: string; missing: string[] }
  | { type: 'check'; id: string; target: string };

export type DispatchToServer =
  | { type: 'welcome'; protocolVersion: string; account?: string }
  | { type: 'refuse'; reason: 'protocol_version' | 'unauthorized'; protocolVersion?: string }
  | { type: 'answer'; id: string; target: string }
  | { type: 'answer'; id: string; deny: true; reason?: string }
  | { type: 'refresh'; id: string }
  | { type: 'revoke'; target: string }
  | { type: 'validate'; id: string; tmuxServer: string; targets: string[] }
  | { type: 'verdict'; id: string; allowed: boolean };

/**
 * Parse a frame defensively: it arrives from another process that may be a
 * different version, so anything unrecognised is dropped rather than trusted.
 */
export function parseDispatchMessage(raw: string): DispatchToServer | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const message = value as { type?: unknown; id?: unknown };
  switch (message.type) {
    case 'validate': {
      const frame = value as { tmuxServer?: unknown; targets?: unknown };
      return typeof message.id === 'string' && typeof frame.tmuxServer === 'string'
        && frame.tmuxServer.length > 0 && Array.isArray(frame.targets)
        && frame.targets.every(target => typeof target === 'string' && /^[%@]\d+$/.test(target))
        ? value as DispatchToServer : null;
    }
    case 'welcome':
    case 'refuse':
      return message as DispatchToServer;
    case 'answer':
    case 'refresh':
      return typeof message.id === 'string' ? (message as DispatchToServer) : null;
    case 'verdict': {
      const { allowed } = value as { allowed?: unknown };
      return typeof message.id === 'string' && typeof allowed === 'boolean'
        ? (message as DispatchToServer)
        : null;
    }
    case 'revoke': {
      const { target } = value as { target?: unknown };
      return typeof target === 'string' ? (message as DispatchToServer) : null;
    }
    default:
      return null;
  }
}
