/**
 * The wire contract with the dispatch service, specified in docs/protocol.md.
 *
 * These types are declared again on the dispatch side. That duplication is
 * deliberate: a published package for six message shapes costs more than it
 * saves, and the two sides are deployed independently anyway, so the contract
 * has to hold at runtime. PROTOCOL_VERSION is what enforces it.
 */

/** "<major>.<minor>". Same major connects; different major refuses. */
export const PROTOCOL_VERSION = '1.0';

export function protocolMajor(version: string): string {
  return version.split('.')[0] ?? '';
}

export function isCompatible(theirs: string): boolean {
  return protocolMajor(theirs) === protocolMajor(PROTOCOL_VERSION);
}

export interface AgentIdentity {
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
    }
  | { type: 'candidates'; id: string; candidates: WireCandidate[] }
  | { type: 'withdraw'; id: string; why: 'expired' | 'answered_elsewhere' | 'shutdown' }
  | { type: 'result'; id: string; ok: true; target: string }
  | { type: 'result'; id: string; ok: false; error: string };

export type DispatchToServer =
  | { type: 'welcome'; protocolVersion: string; account?: string }
  | { type: 'refuse'; reason: 'protocol_version' | 'unauthorized'; protocolVersion?: string }
  | { type: 'answer'; id: string; target: string }
  | { type: 'answer'; id: string; deny: true; reason?: string }
  | { type: 'refresh'; id: string };

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
    case 'welcome':
    case 'refuse':
      return message as DispatchToServer;
    case 'answer':
    case 'refresh':
      return typeof message.id === 'string' ? (message as DispatchToServer) : null;
    default:
      return null;
  }
}
