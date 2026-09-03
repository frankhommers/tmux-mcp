/**
 * Whether a pid still refers to a running process.
 *
 * Shared by the dispatch client (is that daemon still there?) and the request
 * inbox (did the server that asked for this pane die?), so it lives outside
 * both rather than being duplicated.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM means it exists but belongs to someone else.
    return error?.code === 'EPERM';
  }
}
