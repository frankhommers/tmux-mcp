import { parseArgs } from 'node:util';
import {
  listRequestFiles,
  readRequestFile,
  resolveRequestsDir,
  writeAnswerFile,
} from './requests-dir.js';

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
      for (const candidate of request.candidates) {
        console.log(`    ${candidate.label}`);
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
  if (!request.candidates.some(candidate => candidate.id === target)) {
    console.error(`${target} is not one of the candidates for ${requestId}. Offered:`);
    for (const candidate of request.candidates) console.error(`    ${candidate.label}`);
    return 1;
  }

  await writeAnswerFile(dir, requestId, 'grant', target);
  console.log(`Granted ${target} for ${requestId}.`);
  return 0;
}
