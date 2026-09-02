import { parseArgs } from 'node:util';
import {
  listRequestFiles,
  readRequestFile,
  resolveRequestsDir,
  writeAnswerFile,
} from './requests-dir.js';
import { listAllPanes } from './tmux.js';
import type { PaneRequest } from './requests.js';

/**
 * The panes or windows that may be assigned to a request *right now*.
 *
 * Deliberately not the candidate list stored in the request file: that is a
 * snapshot from when the agent asked, and a human usually opens the pane they
 * want to hand over after reading the request. Filtering is done with the
 * scope recorded in the file, so this matches what the server will accept.
 */
async function liveTargets(request: PaneRequest): Promise<Array<{ id: string; label: string }>> {
  const scope = request.scope ?? { mode: 'none', sessionIds: [], windowId: null, excludedPaneId: null };
  const panes = await listAllPanes();
  const targets: Array<{ id: string; label: string }> = [];
  const seenWindows = new Set<string>();

  for (const pane of panes) {
    if (scope.mode === 'session' && !scope.sessionIds.includes(pane.sessionId)) continue;
    if (scope.mode === 'window' && scope.windowId !== pane.windowId) continue;

    if (request.kind === 'window') {
      if (seenWindows.has(pane.windowId)) continue;
      seenWindows.add(pane.windowId);
      targets.push({ id: pane.windowId, label: `${pane.windowId}  ${pane.sessionName}:${pane.windowName}` });
      continue;
    }
    if (scope.excludedPaneId && pane.paneId === scope.excludedPaneId) continue;
    targets.push({
      id: pane.paneId,
      label: `${pane.paneId}  ${pane.sessionName}:${pane.windowName}.${pane.paneIndex}  ${pane.currentCommand}  "${pane.title}"`,
    });
  }
  return targets;
}

export const GRANT_CLI_COMMANDS = ['requests', 'grant', 'deny'] as const;
export type GrantCliCommand = (typeof GRANT_CLI_COMMANDS)[number];

export function isGrantCliCommand(value: string | undefined): value is GrantCliCommand {
  return value !== undefined && (GRANT_CLI_COMMANDS as readonly string[]).includes(value);
}

/**
 * `tmux-mcp requests|grant|deny` — the channel a human can use from any
 * shell, including over SSH where no dialog or popup is available.
 */
export async function runGrantCli(argv: string[]): Promise<number> {
  const command = argv[0] as GrantCliCommand;
  const rest = argv.slice(1);
  const { values, positionals } = parseArgs({
    args: rest,
    options: { 'requests-dir': { type: 'string' } },
    allowPositionals: true,
  });
  const dir = resolveRequestsDir(values['requests-dir'] as string | undefined);

  if (command === 'requests') {
    const requests = await listRequestFiles(dir);
    if (requests.length === 0) {
      console.log('No pending pane requests.');
      return 0;
    }
    for (const request of requests) {
      const ageSeconds = Math.round((Date.now() - request.createdAt) / 1000);
      console.log(`${request.id}  (${ageSeconds}s ago, ${request.kind})  ${request.reason}`);
      // Listed live, so a pane opened since the request shows up here.
      const targets = await liveTargets(request);
      for (const target of targets) {
        console.log(`    ${target.label}`);
      }
      if (targets.length === 0) {
        console.log(`    (no assignable ${request.kind} right now)`);
      }
      console.log(`    grant with: tmux-mcp grant ${request.id} <target>`);
    }
    return 0;
  }

  const requestId = positionals[0];
  if (!requestId) {
    console.error(`Usage: tmux-mcp ${command} <request-id>${command === 'grant' ? ' <target>' : ' [reason]'}`);
    return 1;
  }

  const request = await readRequestFile(dir, requestId);
  if (!request) {
    console.error(`No pending request ${requestId} in ${dir}.`);
    return 1;
  }

  if (command === 'deny') {
    await writeAnswerFile(dir, requestId, 'deny', positionals.slice(1).join(' '));
    console.log(`Denied ${requestId}.`);
    return 0;
  }

  const target = positionals[1];
  if (!target) {
    console.error(`Usage: tmux-mcp grant ${requestId} <target>`);
    return 1;
  }
  const targets = await liveTargets(request);
  if (!targets.some(candidate => candidate.id === target)) {
    console.error(`${target} cannot be assigned to ${requestId}: it does not exist right now, or it falls outside the server's scope. Assignable now:`);
    for (const candidate of targets) console.error(`    ${candidate.label}`);
    if (targets.length === 0) console.error('    (nothing)');
    return 1;
  }

  await writeAnswerFile(dir, requestId, 'grant', target);
  console.log(`Granted ${target} for ${requestId}.`);
  return 0;
}
