import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startDaemon } from './ui/daemon.js';
import {
  acquireSpawnLock,
  clearUiState,
  isProcessAlive,
  readUiState,
  releaseSpawnLock,
  resolveStateDir,
  type UiState,
} from './ui/state.js';
import { resolveRequestsDir } from './requests-dir.js';

/**
 * The server entry point, resolved relative to this module rather than from
 * process.argv[1].
 *
 * argv[1] is whatever started the current process, which is the test file
 * under `node --test`. Spawning that re-runs the test, which spawns again:
 * a fork bomb. index.js is always this file's sibling in build/.
 */
function entryScript(): string {
  return fileURLToPath(new URL('./index.js', import.meta.url));
}

/**
 * When this process last tried to spawn a daemon for a given state dir.
 *
 * A spawn that fails to produce a working daemon must not be retried
 * immediately: if the spawned thing ever re-enters this code, retries turn a
 * bug into a fork bomb. Keyed by state dir so unrelated directories (and
 * tests) are unaffected.
 */
const lastSpawnAt = new Map<string, number>();
const SPAWN_COOLDOWN_MS = 10_000;

export function isUiCliCommand(value: string | undefined): value is 'ui' {
  return value === 'ui';
}

/** Alive means: the process exists AND the port answers as one of ours. */
export async function probeDaemon(state: UiState | null): Promise<boolean> {
  if (!state || !isProcessAlive(state.pid)) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/api/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return false;
    const body = await res.json() as { ok?: boolean; pid?: number };
    return body.ok === true && body.pid === state.pid;
  } catch {
    return false;
  }
}

function daemonUrl(state: UiState): string {
  return `http://127.0.0.1:${state.port}/?t=${state.token}`;
}

async function waitForState(stateDir: string, timeoutMs: number): Promise<UiState | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readUiState(stateDir);
    if (await probeDaemon(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
}

/**
 * Make sure exactly one daemon is running, spawning it if needed. Returns the
 * live state, or null when it could not be started — never throws, because a
 * missing UI must not stop an MCP server from serving.
 */
export async function ensureDaemonRunning(stateDir: string, requestsDir: string): Promise<UiState | null> {
  const existing = await readUiState(stateDir);
  if (await probeDaemon(existing)) return existing;

  // Stale file: the daemon died without cleaning up.
  if (existing) await clearUiState(stateDir);

  if (!(await acquireSpawnLock(stateDir))) {
    // Someone else is spawning right now; wait for their daemon.
    return waitForState(stateDir, 5000);
  }
  try {
    // Double-checked: a daemon may have appeared between the probe above and
    // taking the lock, in which case there is nothing to start.
    const appeared = await readUiState(stateDir);
    if (await probeDaemon(appeared)) return appeared;

    const previous = lastSpawnAt.get(stateDir);
    if (previous !== undefined && Date.now() - previous < SPAWN_COOLDOWN_MS) return null;
    lastSpawnAt.set(stateDir, Date.now());

    // Refuse to spawn anything that is not our own entry point. Spawning the
    // wrong file is what turns a self-starting daemon into a fork bomb.
    const entry = entryScript();
    if (basename(entry) !== 'index.js' || !existsSync(entry)) return null;

    const child = spawn(process.execPath, [
      entry, 'ui', '--detached', `--state-dir=${stateDir}`, `--requests-dir=${requestsDir}`,
    ], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, TMUX_MCP_UI_CHILD: '1' },
    });
    child.unref();
    return await waitForState(stateDir, 5000);
  } catch {
    return null;
  } finally {
    await releaseSpawnLock(stateDir);
  }
}

export async function runUiCli(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      'state-dir': { type: 'string' },
      'requests-dir': { type: 'string' },
      port: { type: 'string' },
      detached: { type: 'boolean', default: false },
      'print-url': { type: 'boolean', default: false },
      stop: { type: 'boolean', default: false },
    },
  });

  const stateDir = resolveStateDir(values['state-dir'] as string | undefined);
  const requestsDir = resolveRequestsDir(values['requests-dir'] as string | undefined);
  const state = await readUiState(stateDir);

  if (values['print-url']) {
    if (await probeDaemon(state)) {
      console.log(daemonUrl(state!));
      return 0;
    }
    console.log('The control UI is not running. Start it with: tmux-mcp ui');
    return 1;
  }

  if (values.stop) {
    if (!state) {
      console.log('The control UI is not running.');
      return 0;
    }
    try { process.kill(state.pid, 'SIGTERM'); } catch { /* already gone */ }
    // The daemon clears its own state on SIGTERM; clean up if it could not.
    for (let i = 0; i < 40 && (await readUiState(stateDir)); i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await clearUiState(stateDir);
    console.log('Stopped the control UI.');
    return 0;
  }

  if (await probeDaemon(state)) {
    console.log(`Already running: ${daemonUrl(state!)}`);
    return 0;
  }
  if (state) await clearUiState(stateDir);

  const portRaw = (values.port as string | undefined) ?? process.env.TMUX_MCP_UI_PORT;
  const port = portRaw === undefined ? 7676 : Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid --port: '${portRaw}'.`);
    return 1;
  }

  let daemon;
  try {
    daemon = await startDaemon({ stateDir, requestsDir, port });
  } catch {
    // The preferred port is taken by something that is not us.
    daemon = await startDaemon({ stateDir, requestsDir, port: 0 });
  }

  const shutdown = () => { void daemon.close().then(() => process.exit(0)); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  if (!values.detached) {
    console.log(`Control UI: http://127.0.0.1:${daemon.port}/?t=${daemon.token}`);
    console.log('Stop it with: tmux-mcp ui --stop');
  }
  // Never resolves: the process lives until a signal arrives.
  await new Promise(() => { /* runs until shutdown */ });
  return 0;
}
