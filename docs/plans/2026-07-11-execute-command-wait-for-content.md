# Execute Command Wait For Content Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an atomic MCP tool that starts a tracked command and returns when plain text or a regex appears in that command's own output, without the baseline race of separate execute and pane-wait calls.

**Architecture:** Reuse the existing unique start/end markers and command registry. Refactor marker parsing so pending commands expose partial command-scoped output, then add a polling helper that checks this output for a match before checking terminal status. Register a thin MCP handler with the same matcher and progress/timeout conventions as the existing wait tools.

**Tech Stack:** TypeScript, Node.js 20, Node's built-in test runner, Zod, MCP TypeScript SDK, tmux.

---

### Task 1: Add The Command-Content Regression Tests

**Files:**
- Create: `test/execute-command-wait-for-content.test.mjs`
- Modify: `package.json:7-13`

**Step 1: Add the test command**

Add this script to `package.json`:

```json
"test": "npm run build && node --test test/*.test.mjs"
```

**Step 2: Write the failing integration tests**

Create `test/execute-command-wait-for-content.test.mjs`. Use a fresh detached tmux session per test so a command left running cannot contaminate another test:

```javascript
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeCommandWaitForContent,
  executeTmux,
  sendInterrupt,
} from '../build/tmux.js';

let sequence = 0;

async function withPane(run) {
  const session = `tmux-mcp-content-${process.pid}-${sequence++}`;
  const paneId = await executeTmux([
    'new-session', '-d', '-s', session, '-P', '-F', '#{pane_id}',
  ]);
  try {
    return await run(paneId);
  } finally {
    await executeTmux(['kill-session', '-t', session]).catch(() => {});
  }
}

test('matches output from a command that exits before the first poll', async () => {
  await withPane(async (paneId) => {
    const result = await executeCommandWaitForContent(
      paneId,
      'printf "READY\\n"',
      'READY',
      { timeoutSeconds: 2, pollIntervalMs: 100 },
    );

    assert.equal(result.status, 'matched');
    assert.equal(result.matchedLine, 'READY');
    assert.match(result.output, /READY/);
  });
});

test('matches readiness output while the command remains running', async () => {
  await withPane(async (paneId) => {
    const result = await executeCommandWaitForContent(
      paneId,
      'printf "Listening on port 3210\\n"; sleep 10',
      'Listening on port \\d+',
      { regex: true, timeoutSeconds: 2, pollIntervalMs: 25 },
    );

    assert.equal(result.status, 'matched');
    assert.equal(result.commandStatus, 'pending');
    await sendInterrupt(paneId);
  });
});

test('returns immediately when the command exits without a match', async () => {
  await withPane(async (paneId) => {
    const result = await executeCommandWaitForContent(
      paneId,
      'printf "NOPE\\n"; exit 7',
      'READY',
      { timeoutSeconds: 2, pollIntervalMs: 25 },
    );

    assert.equal(result.status, 'exited_without_match');
    assert.equal(result.commandStatus, 'error');
    assert.equal(result.exitCode, 7);
    assert.match(result.output, /NOPE/);
  });
});

test('times out without interrupting the command', async () => {
  await withPane(async (paneId) => {
    const result = await executeCommandWaitForContent(
      paneId,
      'sleep 10',
      'READY',
      { timeoutSeconds: 0.1, pollIntervalMs: 25 },
    );

    assert.equal(result.status, 'timed_out');
    assert.equal(result.commandStatus, 'pending');
    assert.ok(result.commandId);
    await sendInterrupt(paneId);
  });
});

test('rejects an invalid regex before starting a command', async () => {
  await withPane(async (paneId) => {
    await assert.rejects(
      executeCommandWaitForContent(
        paneId,
        'printf "SHOULD_NOT_RUN\\n"',
        '[invalid',
        { regex: true, timeoutSeconds: 1 },
      ),
      /Invalid regex pattern/,
    );

    const pane = await executeTmux(['capture-pane', '-p', '-t', paneId]);
    assert.doesNotMatch(pane, /SHOULD_NOT_RUN/);
  });
});
```

**Step 3: Run the tests to verify they fail**

Run: `npm test`

Expected: FAIL because `build/tmux.js` does not export `executeCommandWaitForContent`.

**Step 4: Commit the failing tests**

```bash
git add package.json test/execute-command-wait-for-content.test.mjs
git commit -m "test: cover command content waiting"
```

### Task 2: Expose Partial Tracked-Command Output

**Files:**
- Modify: `src/tmux.ts:32-41`
- Modify: `src/tmux.ts:50-65`
- Modify: `src/tmux.ts:241-279`
- Modify: `src/tmux.ts:493-557`

**Step 1: Add raw tracked capture and a shared marker parser**

Keep the existing trimmed `executeTmux` behavior for general callers, but add a
raw path and a tracked-command capture helper so protocol framing and exposed
whitespace reach the parser unchanged:

```typescript
async function executeTmuxRaw(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile('tmux', args);
    return stdout;
  } catch (error: any) {
    throw new Error(`Failed to execute tmux command: ${error.message}`);
  }
}

export async function executeTmux(args: string[]): Promise<string> {
  return (await executeTmuxRaw(args)).trim();
}

async function captureTrackedCommandContent(paneId: string, lines: number = 3000): Promise<string> {
  const cursorY = await executeTmux([
    'display-message', '-p', '-t', paneId, '#{cursor_y}',
  ]);
  const raw = await executeTmuxRaw([
    'capture-pane', '-p', '-J', '-t', paneId,
    '-S', `-${lines}`, '-E', cursorY,
  ]);
  const content = raw.endsWith('\r\n')
    ? raw.slice(0, -2)
    : raw.endsWith('\n')
      ? raw.slice(0, -1)
      : raw;
  const allLines = content.split('\n');
  return allLines.length > lines ? allLines.slice(-lines).join('\n') : content;
}
```

Use `-J` to join soft-wrapped terminal rows into logical lines. Do not add
`-N`: its physical-width padding is synthetic and would make trailing spaces
look like command output. Tmux's terminal grid does not reliably expose exact
trailing spaces at physical line ends, so matching must not promise them.

Add a private parser near `checkCommandStatus`:

```typescript
interface CommandOutputSnapshot {
  output: string;
  exitCode: number | null;
}

function parseCommandOutput(command: CommandExecution, content: string): CommandOutputSnapshot | null {
  const startMarker = getStartMarkerText(command);
  const startIndex = content.lastIndexOf(startMarker);
  if (startIndex === -1) return null;

  const outputStart = startIndex + startMarker.length;
  const endMarkerPrefix = getEndMarkerPrefix(command);
  const endMarkerRegex = new RegExp(`^${endMarkerPrefix}(\\d+)\\r?$`, 'gm');
  const contentAfterStart = content.substring(outputStart);
  let endMarkerMatch: RegExpExecArray | null;
  let matchingEndMarker: RegExpExecArray | null = null;

  while ((endMarkerMatch = endMarkerRegex.exec(contentAfterStart)) !== null) {
    matchingEndMarker = endMarkerMatch;
  }

  const outputEnd = matchingEndMarker
    ? outputStart + matchingEndMarker.index
    : content.length;
  let output = content.substring(outputStart, outputEnd);

  if (output.startsWith('\r\n')) {
    output = output.substring(2);
  } else if (output.startsWith('\n')) {
    output = output.substring(1);
  }

  if (matchingEndMarker) {
    if (output.endsWith('\r\n')) {
      output = output.substring(0, output.length - 2);
    } else if (output.endsWith('\n')) {
      output = output.substring(0, output.length - 1);
    }
  }

  return {
    output,
    exitCode: matchingEndMarker ? parseInt(matchingEndMarker[1], 10) : null,
  };
}
```

Keep `getStartMarkerText` and `getEndMarkerPrefix` as the single source of
marker names. Search only after the unique start marker and accept an end
marker only as a complete CRLF/LF line. Remove only the protocol framing
newline after the start marker and before a real end marker. Preserve leading
and internal whitespace, exposed trailing whitespace, and logical newlines
without trimming. Exact trailing spaces at physical terminal-line ends remain
subject to tmux grid fidelity and must not be relied upon.

**Step 2: Refactor `checkCommandStatus` to store partial output**

Replace its inline marker parsing with:

```typescript
const content = await captureTrackedCommandContent(command.paneId);
const snapshot = parseCommandOutput(command, content);

if (!snapshot) {
  command.result = 'Command output could not be captured properly';
  return command;
}

command.capturedOutput = snapshot.output;
command.result = snapshot.output;
if (snapshot.exitCode !== null) {
  const exitCode = snapshot.exitCode;
  const newStatus: 'completed' | 'error' = exitCode === 0 ? 'completed' : 'error';
  command.status = newStatus;
  command.exitCode = exitCode;
  activeCommands.set(commandId, command);
  emitCommandStatusChange(commandId, newStatus);
}

return command;
```

Preserve the existing early return for commands already in a terminal state and the existing raw-mode message.

**Step 3: Build to verify the refactor**

Run: `npm run build`

Expected: PASS with no TypeScript errors.

**Step 4: Run the tests and confirm only the missing function remains**

Run: `npm test`

Expected: FAIL because `executeCommandWaitForContent` is still not exported; existing compilation succeeds.

**Step 5: Commit the marker-parser refactor**

```bash
git add src/tmux.ts
git commit -m "refactor: expose pending command output"
```

### Task 3: Implement Command-Scoped Content Waiting

**Files:**
- Modify: `src/tmux.ts:656-790`
- Test: `test/execute-command-wait-for-content.test.mjs`

**Step 1: Add result and option types**

Add near the existing blocking result types:

```typescript
export type CommandContentWaitStatus =
  | 'matched'
  | 'exited_without_match'
  | 'timed_out';

export interface CommandContentWaitResult {
  commandId: string;
  status: CommandContentWaitStatus;
  commandStatus: 'pending' | 'completed' | 'error';
  exitCode: number | null;
  output: string;
  matchedLine?: string;
}

export interface CommandContentWaitOptions {
  regex?: boolean;
  timeoutSeconds: number;
  pollIntervalMs?: number;
  suppressHistory?: boolean;
  progress?: ProgressEmitter;
}
```

**Step 2: Add a line matcher**

Validate regex construction before command execution. Matching is line-by-line
for both substring and regex modes, so patterns cannot span lines:

```typescript
function createLineMatcher(pattern: string, regex: boolean = false): (line: string) => boolean {
  if (!regex) return line => line.includes(pattern);
  try {
    const matcher = new RegExp(pattern);
    return line => matcher.test(line);
  } catch (error: any) {
    throw new Error(`Invalid regex pattern "${pattern}": ${error.message}`);
  }
}
```

**Step 3: Implement the polling function**

Add `executeCommandWaitForContent` next to `runBlocking`:

```typescript
export async function executeCommandWaitForContent(
  paneId: string,
  command: string,
  pattern: string,
  opts: CommandContentWaitOptions,
): Promise<CommandContentWaitResult> {
  if (pattern.length === 0) {
    throw new Error('pattern must not be empty');
  }
  const matches = createLineMatcher(pattern, opts.regex);
  if (!Number.isFinite(opts.timeoutSeconds) || opts.timeoutSeconds <= 0) {
    throw new Error('timeoutSeconds must be a positive finite number');
  }
  if (opts.pollIntervalMs !== undefined &&
      (!Number.isFinite(opts.pollIntervalMs) || opts.pollIntervalMs <= 0)) {
    throw new Error('pollIntervalMs must be a positive finite number');
  }

  const deadline = Date.now() + opts.timeoutSeconds * 1000;
  const commandId = await executeCommand(paneId, command, {
    suppressHistory: opts.suppressHistory,
  });
  const pollIntervalMs = opts.pollIntervalMs ?? 500;
  let commandState = getCommand(commandId);
  if (!commandState) throw new Error(`Tracked command ${commandId} not found`);

  const timedOut = (): CommandContentWaitResult => ({
    commandId,
    status: 'timed_out',
    commandStatus: commandState!.status,
    exitCode: commandState!.exitCode ?? null,
    output: commandState!.capturedOutput ?? '',
  });

  while (true) {
    if (Date.now() >= deadline) return timedOut();

    commandState = await checkCommandStatus(commandId);
    if (!commandState) throw new Error(`Tracked command ${commandId} not found`);
    if (Date.now() >= deadline) return timedOut();

    const output = commandState.capturedOutput ?? '';
    const matchedLine = output.split('\n').find(matches);
    if (matchedLine !== undefined) {
      return {
        commandId,
        status: 'matched',
        commandStatus: commandState.status,
        exitCode: commandState.exitCode ?? null,
        output,
        matchedLine,
      };
    }

    if (commandState.status !== 'pending') {
      return {
        commandId,
        status: 'exited_without_match',
        commandStatus: commandState.status,
        exitCode: commandState.exitCode ?? null,
        output,
      };
    }

    await opts.progress?.tickIfDue(`waiting for command content in pane ${paneId}`);

    const remaining = deadline - Date.now();
    if (remaining <= 0) return timedOut();
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}
```

The deadline is created before `executeCommand`, so submission time counts.
Check it immediately after every capture and before accepting a newly observed
match or exit. Match-over-exit precedence therefore applies only to a capture
completed before the deadline. Do not add interrupt behavior. A timed-out
result may carry a terminal `commandStatus` and exit code captured after the
deadline; use the returned command ID for later polling only while its status is
`pending`.

**Step 4: Run the focused tests**

Run: `npm test`

Expected: all tests PASS.

**Step 5: Commit the core implementation**

```bash
git add src/tmux.ts
git commit -m "feat: wait for tracked command content"
```

### Task 4: Register The MCP Tool

**Files:**
- Modify: `src/index.ts:806-945`

**Step 1: Add a result formatter**

Add next to `formatBlockingResult`:

```typescript
function formatCommandContentWaitResult(res: tmux.CommandContentWaitResult): string {
  const lines = [
    `Status: ${res.status}`,
    `Command status: ${res.commandStatus}`,
    `Exit code: ${res.exitCode === null ? 'n/a' : res.exitCode}`,
    `Command ID: ${res.commandId}`,
  ];
  if (res.matchedLine !== undefined) lines.push(`Matched line: ${res.matchedLine}`);
  lines.push('', '--- Output ---', res.output);
  if (res.status === 'matched' && res.commandStatus === 'pending') {
    lines.push('', `NOTE: The match returned while Command status is pending. Poll Command ID ${res.commandId} with 'get-command-result' for completion and final output.`);
  } else if (res.status === 'timed_out') {
    const running = res.commandStatus === 'pending' ? ' The command is still running in the pane.' : '';
    lines.push('', `NOTE: Timed out; no interrupt occurred.${running}`);
  }
  return lines.join('\n');
}
```

**Step 2: Register `execute-command-wait-for-content`**

Place it between `execute-command-async` and `execute-command-kill-after`. Its schema is:

```typescript
{
  paneId: z.string().describe('ID of the tmux pane'),
  command: z.string().describe('Command to execute'),
  text: z.string().min(1).describe('Non-empty plain text or regex pattern to find in this command output'),
  regex: z.boolean().optional().describe('Interpret text as a regular expression. Default: false'),
  timeoutSeconds: z.number().positive().describe('Maximum seconds to wait for a match or command exit'),
  pollIntervalMs: z.number().positive().optional().describe('How often to check command output. Default: 500'),
  suppressHistory: z.boolean().optional().describe('Prepend a space to avoid shell history. Default: true.'),
}
```

The tool description must explicitly say that it atomically starts observation
and command execution, only matches output from this tracked command, matches
line-by-line, and uses a deadline that includes submission and is rechecked
after capture before accepting match or exit. State that timeout never
interrupts, a timed-out command may already be terminal, and only pending
commands should be polled afterward. Qualify the server cap as applying only
without a progress token, and state that `matched` is MCP success while
`exited_without_match` and `timed_out` set `isError: true`. The tool does not
support `rawMode`/`noEnter`.

**Step 3: Implement the handler with existing guards**

Use the same sequence as other blocking tools:

```typescript
async (args, extra) => {
  try {
    if (isExcludedPane(args.paneId)) {
      return {
        content: [{ type: 'text', text: `Access denied: pane ${args.paneId} is the agent's own pane and cannot be interacted with.` }],
        isError: true,
      };
    }
    const progress = createProgressEmitter(extra, 'execute-command-wait-for-content');
    if (!progress.hasToken()) {
      const cap = checkBlockingTimeout(args.timeoutSeconds);
      if (!cap.ok) {
        return { content: [{ type: 'text', text: cap.message }], isError: true };
      }
    }
    await assertInScope(args.paneId, 'pane');
    const result = await tmux.executeCommandWaitForContent(
      args.paneId,
      args.command,
      args.text,
      {
        regex: args.regex,
        timeoutSeconds: args.timeoutSeconds,
        pollIntervalMs: args.pollIntervalMs,
        suppressHistory: args.suppressHistory,
        progress,
      },
    );
    return {
      content: [{ type: 'text', text: formatCommandContentWaitResult(result) }],
      isError: result.status !== 'matched',
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error executing command: ${error}` }],
      isError: true,
    };
  }
}
```

The handler's `isError: result.status !== 'matched'` means `matched` is an MCP
success, while `exited_without_match` and `timed_out` are MCP errors. With a
progress token, the first notification follows the first successful poll that
leaves the command pending, then notifications occur approximately every 25
seconds after successful pending polls. Poll failures or hangs emit no
notification. The blocking cap applies only when no progress token is present.

**Step 4: Update adjacent tool guidance**

Update the descriptions of `execute-command-async` and `wait-for-pane-content` to direct agents to `execute-command-wait-for-content` when they launch a command and need to wait for its output. Keep `wait-for-pane-content` positioned for external or untracked pane activity.

**Step 5: Build and run tests**

Run: `npm test`

Expected: TypeScript build succeeds and all tests PASS.

**Step 6: Commit the MCP registration**

```bash
git add src/index.ts
git commit -m "feat: expose command content wait tool"
```

### Task 5: Document And Verify The Complete Feature

**Files:**
- Modify: `README.md:113-141`
- Modify: `README.md:181-192`
- Reference: `docs/plans/2026-07-11-execute-command-wait-for-content-design.md`

**Step 1: Add the tool to the README list**

Add:

```markdown
- `execute-command-wait-for-content` - Execute a tracked command and block until plain text or a regex appears in that command's output; returns on command exit observed before the deadline and never interrupts on timeout
```

Include it in the list of blocking tools that support progress notifications.

**Step 2: Document when to use each wait style**

Add a short subsection explaining:

```markdown
- Use `execute-command-wait-for-exit` when completion is the condition.
- Use `execute-command-wait-for-content` when output/readiness is the condition.
- Use `wait-for-pane-content` only for pane activity not launched as a tracked command by the same call.
```

Document line-by-line matching, strict deadline ordering, `text`, `regex`,
`timeoutSeconds`, the three result statuses, and their MCP `isError` values.
State that timeout does not interrupt the command, a timeout result may already
have terminal command status, and follow-up polling applies only while status is
`pending`. Document that progress starts after the first successful pending
poll, repeats approximately every 25 seconds, and stops when tmux polling fails
or hangs.

**Step 3: Run complete verification**

Run: `npm test`

Expected: build succeeds and all tests PASS.

Run: `npm run check-release`

Expected: TypeScript build succeeds and `npm publish --dry-run` lists the expected package files without errors.

Run: `git diff --check`

Expected: no whitespace errors.

**Step 4: Review the final diff**

Run: `git status --short && git diff --stat && git diff`

Expected: only the implementation, tests, README, and approved plan documents are present.

**Step 5: Commit the documentation**

```bash
git add README.md docs/plans/2026-07-11-execute-command-wait-for-content-design.md docs/plans/2026-07-11-execute-command-wait-for-content.md
git commit -m "docs: explain command content waiting"
```
