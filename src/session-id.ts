/**
 * Which agent session this server belongs to, as the user configured it.
 *
 * Several agents can run from the same directory at once, and to dispatch they
 * look identical: same host, same cwd, same client. A session id tells them
 * apart, and because it can outlive one server process (an agent restarting
 * its MCP servers keeps its thread), a rule bound to it survives that restart.
 *
 * tmux-mcp knows no harness. The user says where the id comes from: a literal
 * value, or the names of environment variables the agent's host sets. Without
 * either there is no session id, and dispatch falls back to the process.
 */

export interface SessionIdSource {
  /** `--session-id`; falls back to TMUX_MCP_SESSION_ID. */
  value?: string;
  /** `--session-id-env`, comma separated; falls back to TMUX_MCP_SESSION_ID_ENV. */
  envNames?: string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

/** Long enough for any UUID or thread name, short enough to never flood a frame. */
const MAX_LENGTH = 200;

/** Trimmed and clamped, or undefined: a bad variable cannot flood the wire. */
export function sanitizeSessionId(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed.slice(0, MAX_LENGTH) : undefined;
}

const clean = sanitizeSessionId;

/** The variable names `--session-id-env` configured, in order. */
export function envNameList(
  envNames: string | undefined,
  env: SessionIdSource['env'],
): string[] {
  return (envNames ?? env.TMUX_MCP_SESSION_ID_ENV ?? '')
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);
}

export function resolveSessionId({ value, envNames, env }: SessionIdSource): string | undefined {
  const explicit = clean(value) ?? clean(env.TMUX_MCP_SESSION_ID);
  if (explicit) return explicit;

  for (const name of envNameList(envNames, env)) {
    const found = clean(env[name]);
    if (found) return found;
  }
  return undefined;
}
