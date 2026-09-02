import { randomBytes } from 'node:crypto';
import { open, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isProcessAlive } from '../process-alive.js';

export { isProcessAlive };

/** What a running daemon advertises to anything that wants to reach it. */
export interface UiState {
  pid: number;
  port: number;
  token: string;
  startedAt: number;
  version: string;
}

const LOCK_STALE_MS = 30_000;

export function resolveStateDir(cliValue?: string): string {
  return cliValue ?? process.env.TMUX_MCP_STATE_DIR ?? join(homedir(), '.tmux-mcp');
}

export function stateFilePath(stateDir: string): string {
  return join(stateDir, 'ui.json');
}

function lockFilePath(stateDir: string): string {
  return join(stateDir, 'ui.lock');
}

async function ensureStateDir(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
}

export async function writeUiState(stateDir: string, state: UiState): Promise<void> {
  await ensureStateDir(stateDir);
  await writeFile(stateFilePath(stateDir), JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** Returns null when the file is missing, unreadable, or not valid state. */
export async function readUiState(stateDir: string): Promise<UiState | null> {
  try {
    const parsed = JSON.parse(await readFile(stateFilePath(stateDir), 'utf8')) as UiState;
    if (typeof parsed?.pid !== 'number' || typeof parsed?.port !== 'number' || typeof parsed?.token !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function clearUiState(stateDir: string): Promise<void> {
  await rm(stateFilePath(stateDir), { force: true });
}



export function newToken(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Exclusive lock so two MCP servers starting at the same moment do not both
 * spawn a daemon. 'wx' fails when the file exists, which makes the create
 * itself the atomic operation.
 */
export async function acquireSpawnLock(stateDir: string, staleMs: number = LOCK_STALE_MS): Promise<boolean> {
  await ensureStateDir(stateDir);
  const path = lockFilePath(stateDir);
  try {
    const handle = await open(path, 'wx', 0o600);
    await handle.writeFile(String(process.pid));
    await handle.close();
    return true;
  } catch {
    // Held by someone else — unless it was abandoned.
    try {
      const age = Date.now() - (await stat(path)).mtimeMs;
      if (age > staleMs) {
        await rm(path, { force: true });
        return acquireSpawnLock(stateDir, staleMs);
      }
    } catch {
      // Vanished between the failed create and the stat: let the caller retry.
    }
    return false;
  }
}

export async function releaseSpawnLock(stateDir: string): Promise<void> {
  await rm(lockFilePath(stateDir), { force: true });
}
