# Progress Notifications Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Emit `notifications/progress` from the five blocking MCP tools when the request carried a `progressToken`, and lift the 59s timeout cap in that case. Behavior is unchanged for clients that do not send a token.

**Architecture:** A single `ProgressEmitter` abstraction is constructed per request from the SDK's `extra` argument. It holds the token (if any) and rate-limits notifications to one per 25s. The emitter is threaded down into the existing tmux polling primitives (`runBlocking`, `pollPaneContent`) and into the `sleep` tool's loop, where it is ticked **only after a successful tmux poll** (or, for `sleep`, after a successful 1s tick). Tool handlers skip the existing `checkBlockingTimeout` cap when the token is present.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` ^1.0.2 (`ProgressNotificationSchema`, `RequestHandlerExtra`), Zod, existing tmux helpers.

**Reference:** Design at `docs/plans/2026-05-06-progress-notifications-design.md`. SDK shapes verified at:
- `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.d.ts:173-207` — `RequestHandlerExtra` exposes `_meta?: RequestMeta`, `requestId`, and `sendNotification(notification): Promise<void>`.
- `node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts:46-57` — `RequestMetaSchema` defines `progressToken?: string | number`.
- `node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts:950-970` — `ProgressNotificationSchema`: `{ method: "notifications/progress", params: { progressToken, progress, total?, message? } }`.

**Constraints:**
- No automated tests; verification is manual (the project has no test harness).
- Do not change behavior for clients that omit `progressToken`. The 59s cap stays in force for them.
- The notification's `progress` field must be monotonically increasing per token (spec requirement).
- A failed `sendNotification` must never fail the tool call.

---

## Task 1: Create the progress emitter module

**Files:**
- Create: `src/progress.ts`

**Step 1: Write `src/progress.ts`**

```ts
// Progress notifications for blocking tools.
//
// MCP clients that include a `progressToken` in `request._meta` are signaling
// they want out-of-band progress notifications and (per spec) that they will
// reset their per-request timer when one arrives. Emitting one every ~25s
// from inside our blocking-tool poll loops lets long waits run past the
// client's normal request timeout without falsely triggering it.
//
// CRITICAL: notifications must only fire AFTER a successful underlying poll
// (e.g. a successful tmux capture). If our process or its tmux subprocess
// hangs, no notification is emitted, and the client's timeout correctly
// signals unresponsiveness. See docs/plans/2026-05-06-progress-notifications-design.md.

type ProgressToken = string | number;

interface ExtraLike {
  _meta?: { progressToken?: ProgressToken } & Record<string, unknown>;
  sendNotification: (notification: {
    method: 'notifications/progress';
    params: {
      progressToken: ProgressToken;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

export interface ProgressEmitter {
  /** True if the request carried a progressToken. */
  hasToken(): boolean;
  /** Fire a progress notification if at least `intervalMs` has elapsed since
   *  the last one. Call only after a successful poll iteration. */
  tickIfDue(context?: string): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 25_000;

const NOOP: ProgressEmitter = {
  hasToken: () => false,
  tickIfDue: async () => {},
};

export function createProgressEmitter(
  extra: ExtraLike | undefined,
  toolName: string,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): ProgressEmitter {
  const token = extra?._meta?.progressToken;
  if (token === undefined || token === null) return NOOP;

  const startedAt = Date.now();
  let lastEmittedAt = 0;
  let counter = 0;
  let warned = false;

  return {
    hasToken: () => true,
    async tickIfDue(context?: string) {
      const now = Date.now();
      if (now - lastEmittedAt < intervalMs) return;
      lastEmittedAt = now;
      counter += 1;
      const elapsedSec = Math.round((now - startedAt) / 1000);
      const message = context
        ? `${toolName}: ${elapsedSec}s elapsed, ${context}`
        : `${toolName}: ${elapsedSec}s elapsed`;
      try {
        await extra!.sendNotification({
          method: 'notifications/progress',
          params: { progressToken: token, progress: counter, message },
        });
      } catch (err) {
        // A failed notification must never break the tool call. Log once.
        if (!warned) {
          warned = true;
          console.error(`[progress] sendNotification failed for ${toolName}:`, err);
        }
      }
    },
  };
}
```

**Step 2: Compile to verify the module type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

**Step 3: Commit**

```bash
git add src/progress.ts
git commit -m "Add ProgressEmitter for notifications/progress on blocking tools"
```

---

## Task 2: Thread the emitter through `runBlocking`

**Files:**
- Modify: `src/tmux.ts:603-612` (extend `RunBlockingOptions`)
- Modify: `src/tmux.ts:632-715` (poll loop in `runBlocking`)

**Step 1: Add the optional emitter field to `RunBlockingOptions`**

Add an `import` at the top of `src/tmux.ts` (near the existing imports):

```ts
import type { ProgressEmitter } from './progress.js';
```

Modify `RunBlockingOptions` (currently lines 603-612). Add one line at the bottom of the interface, before the closing brace:

```ts
  progress?: ProgressEmitter;     // emit progress notifications during the wait
```

**Step 2: Tick the emitter inside the poll loop**

In `runBlocking` (lines 663-689), the loop currently looks like:

```ts
  while (true) {
    const status = await checkCommandStatus(commandId);
    if (status && status.status !== 'pending') {
      // ... return result
    }

    if (Date.now() >= deadline) break;

    const remaining = deadline - Date.now();
    await sleep(Math.min(pollIntervalMs, Math.max(remaining, 0)));
  }
```

Add a tick after `checkCommandStatus` succeeds and we're staying in the loop. Replace the loop with:

```ts
  while (true) {
    const status = await checkCommandStatus(commandId);
    if (status && status.status !== 'pending') {
      const exitCode = status.exitCode ?? null;
      if (wantsTimeout && (exitCode === 124 || exitCode === 137)) {
        return {
          commandId,
          status: 'timed_out_interrupted',
          exitCode,
          output: status.result ?? '',
        };
      }
      return {
        commandId,
        status: status.status === 'completed' ? 'completed' : 'error',
        exitCode,
        output: status.result ?? '',
      };
    }

    // Successful poll (status returned, command still pending) — eligible to
    // emit a keepalive. If checkCommandStatus had thrown or hung, we'd never
    // reach this line, which is the desired behavior.
    await opts.progress?.tickIfDue('command still running');

    if (Date.now() >= deadline) break;

    const remaining = deadline - Date.now();
    await sleep(Math.min(pollIntervalMs, Math.max(remaining, 0)));
  }
```

**Step 3: Compile to verify**

Run: `npx tsc --noEmit`
Expected: no errors.

**Step 4: Commit**

```bash
git add src/tmux.ts
git commit -m "Thread ProgressEmitter through runBlocking poll loop"
```

---

## Task 3: Thread the emitter through `pollPaneContent`

**Files:**
- Modify: `src/tmux.ts:614-620` (extend `WaitForPaneContentOptions`)
- Modify: `src/tmux.ts:1064-1139` (`pollPaneContent` and the public wrappers above it)

**Step 1: Add `progress` to `WaitForPaneContentOptions`**

Modify the interface at lines 614-620:

```ts
export interface WaitForPaneContentOptions {
  regex?: boolean;
  timeoutSeconds: number;
  pollIntervalMs?: number;
  lines?: number;
  ignoreExisting?: boolean;
  progress?: ProgressEmitter;
}
```

**Step 2: Tick after each successful capture in `pollPaneContent`**

In `pollPaneContent` (lines 1090-1136), the loop currently does:

```ts
  while (Date.now() < deadline) {
    const content = await capturePaneContent(paneId, options.lines ?? 200);
    // ... matching logic ...

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.max(Math.min(pollInterval, remaining), 0));
  }
```

Add a tick after the `capturePaneContent` call succeeds — before the matching logic. The final loop body should be:

```ts
  while (Date.now() < deadline) {
    const content = await capturePaneContent(paneId, options.lines ?? 200);
    // Successful capture — eligible to emit keepalive.
    await options.progress?.tickIfDue(`polling pane ${paneId}`);

    const allLines = content.split('\n');
    // ... existing matching logic unchanged ...
```

**Step 3: Compile to verify**

Run: `npx tsc --noEmit`
Expected: no errors.

**Step 4: Commit**

```bash
git add src/tmux.ts
git commit -m "Thread ProgressEmitter through pollPaneContent"
```

---

## Task 4: Wire emitter into `execute-command-kill-after`

**Files:**
- Modify: `src/index.ts:719-757`

**Step 1: Add the import**

Near the top of `src/index.ts` (after the existing imports around line 8), add:

```ts
import { createProgressEmitter } from './progress.js';
```

**Step 2: Update the handler signature and body**

Replace the handler at lines 733-756 with:

```ts
  async (args, extra) => {
    try {
      if (isExcludedPane(args.paneId)) {
        return { content: [{ type: "text", text: `Access denied: pane ${args.paneId} is the agent's own pane and cannot be interacted with.` }], isError: true };
      }
      const progress = createProgressEmitter(extra, "execute-command-kill-after");
      if (!progress.hasToken()) {
        const cap = checkBlockingTimeout(args.timeoutSeconds);
        if (!cap.ok) {
          return { content: [{ type: "text", text: cap.message }], isError: true };
        }
      }
      await assertInScope(args.paneId, 'pane');
      const result = await tmux.runBlocking(args.paneId, args.command, {
        timeoutSeconds: args.timeoutSeconds,
        pollIntervalMs: args.pollIntervalMs,
        interruptOnTimeout: args.interruptOnTimeout,
        interruptCount: args.interruptCount,
        interruptIntervalMs: args.interruptIntervalMs,
        postInterruptWaitMs: args.postInterruptWaitMs,
        suppressHistory: args.suppressHistory,
        progress,
      });
      return { content: [{ type: "text", text: formatBlockingResult(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error executing command: ${error}` }], isError: true };
    }
  }
```

**Step 3: Compile to verify**

Run: `npx tsc --noEmit`
Expected: no errors.

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "Emit progress from execute-command-kill-after when token present"
```

---

## Task 5: Wire emitter into `execute-command-wait-for-exit`

**Files:**
- Modify: `src/index.ts:759-781`

**Step 1: Update the handler**

This tool has no `timeoutSeconds` parameter, so there is no cap to skip; we just pass the emitter through.

Replace the handler at lines 769-780 with:

```ts
  async ({ paneId, command, pollIntervalMs, suppressHistory }, extra) => {
    try {
      if (isExcludedPane(paneId)) {
        return { content: [{ type: "text", text: `Access denied: pane ${paneId} is the agent's own pane and cannot be interacted with.` }], isError: true };
      }
      await assertInScope(paneId, 'pane');
      const progress = createProgressEmitter(extra, "execute-command-wait-for-exit");
      const result = await tmux.runBlocking(paneId, command, { pollIntervalMs, suppressHistory, progress });
      return { content: [{ type: "text", text: formatBlockingResult(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error executing command: ${error}` }], isError: true };
    }
  }
```

**Step 2: Compile to verify**

Run: `npx tsc --noEmit`
Expected: no errors.

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "Emit progress from execute-command-wait-for-exit"
```

---

## Task 6: Wire emitter into `wait-for-pane-content`

**Files:**
- Modify: `src/index.ts:1171-1218` (the `wait-for-pane-content` tool)

**Step 1: Update the handler**

Replace the handler body at lines 1181-1217 with:

```ts
  async ({ paneId, text, regex, ignoreExisting, timeoutSeconds, pollIntervalMs, lines }, extra) => {
    try {
      if (isExcludedPane(paneId)) {
        return { content: [{ type: "text", text: `Access denied: pane ${paneId} is the agent's own pane and cannot be interacted with.` }], isError: true };
      }
      const progress = createProgressEmitter(extra, "wait-for-pane-content");
      if (!progress.hasToken()) {
        const cap = checkBlockingTimeout(timeoutSeconds);
        if (!cap.ok) {
          return { content: [{ type: "text", text: cap.message }], isError: true };
        }
      }
      await assertInScope(paneId, 'pane');

      const linesNum = lines !== undefined ? parseInt(lines, 10) : undefined;
      if (lines !== undefined && (Number.isNaN(linesNum!) || linesNum! <= 0)) {
        return { content: [{ type: "text", text: `Error: lines must be a positive integer, got '${lines}'` }], isError: true };
      }

      const result = await tmux.waitForPaneContent(paneId, text, {
        regex,
        ignoreExisting,
        timeoutSeconds,
        pollIntervalMs,
        lines: linesNum,
        progress,
      });

      if (result.found) {
        return { content: [{ type: "text", text: `Pattern matched. Matched line: ${result.matchedLine}` }] };
      }
      return { content: [{ type: "text", text: `Timeout after ${timeoutSeconds}s: pattern not found in pane content` }], isError: true };
    } catch (error) {
      return { content: [{ type: "text", text: `Error during wait: ${error}` }], isError: true };
    }
  }
```

> **Important:** Before editing, re-read the existing handler at `src/index.ts:1181-1217` and preserve any logic that does not appear above (the snippet matches the design but there may be small differences such as `lines` parsing). Do not regress existing validations.

**Step 2: Compile to verify**

Run: `npx tsc --noEmit`
Expected: no errors.

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "Emit progress from wait-for-pane-content"
```

---

## Task 7: Wire emitter into `wait-for-pane-content-gone`

**Files:**
- Modify: `src/index.ts:1220-1267`

**Step 1: Update the handler**

Apply the same shape as Task 6 but for the gone variant. Re-read the existing handler at `src/index.ts:1231-1266` first; mirror its existing behavior exactly, only adding the emitter wiring and the cap-skip-on-token branch.

Pattern to apply:

```ts
async ({ paneId, text, regex, ignoreExisting, timeoutSeconds, pollIntervalMs, lines }, extra) => {
  try {
    // ...isExcludedPane check (preserve existing)...
    const progress = createProgressEmitter(extra, "wait-for-pane-content-gone");
    if (!progress.hasToken()) {
      const cap = checkBlockingTimeout(timeoutSeconds);
      if (!cap.ok) {
        return { content: [{ type: "text", text: cap.message }], isError: true };
      }
    }
    // ...assertInScope, lines parsing, existing call to waitForPaneContentGone...
    // ...add `progress` to the options passed to waitForPaneContentGone...
  } catch (...) { ... }
}
```

**Step 2: Compile to verify**

Run: `npx tsc --noEmit`
Expected: no errors.

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "Emit progress from wait-for-pane-content-gone"
```

---

## Task 8: Wire emitter into `sleep` (with 1s ticking loop)

**Files:**
- Modify: `src/index.ts:1268-1290`

**Step 1: Replace the single `setTimeout` with a loop**

Current handler (lines 1275-1289) does `await new Promise(resolve => setTimeout(resolve, seconds * 1000))`. Replace the handler body with:

```ts
  async ({ seconds }, extra) => {
    try {
      if (seconds <= 0) {
        return { content: [{ type: "text", text: "Error: seconds must be greater than 0" }], isError: true };
      }
      const progress = createProgressEmitter(extra, "sleep");
      if (!progress.hasToken()) {
        const cap = checkBlockingTimeout(seconds);
        if (!cap.ok) {
          return { content: [{ type: "text", text: cap.message }], isError: true };
        }
      }
      const deadline = Date.now() + seconds * 1000;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        await new Promise(r => setTimeout(r, Math.min(1000, remaining)));
        // Successful event-loop tick — for sleep this is the unresponsiveness
        // signal we have. If the loop wedges, we never tick.
        await progress.tickIfDue();
      }
      return { content: [{ type: "text", text: `Slept for ${seconds}s` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error during sleep: ${error}` }], isError: true };
    }
  }
```

**Step 2: Compile to verify**

Run: `npx tsc --noEmit`
Expected: no errors.

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "Emit progress and tick at 1s intervals in sleep tool"
```

---

## Task 9: Update tool descriptions to document the token-aware behavior

**Files:**
- Modify: `src/index.ts:721` (`execute-command-kill-after` description)
- Modify: `src/index.ts:762` (`execute-command-wait-for-exit` description)
- Modify: `src/index.ts:1171` (`wait-for-pane-content` description)
- Modify: `src/index.ts:1221` (`wait-for-pane-content-gone` description)
- Modify: `src/index.ts:1271` (`sleep` description)

**Step 1: Add a shared phrase helper**

In `src/index.ts`, near the existing `clientTimeoutPhrase()` and `maxSecondsPhrase()` helpers (around lines 53-67), add:

```ts
function progressTokenNote(): string {
  return "When the client sends a `progressToken` (per the MCP spec), this server emits `notifications/progress` every ~25s during the wait and the cap above does NOT apply — `timeoutSeconds`/`seconds` is honored as-is. When the client does not send a token, the cap is enforced.";
}
```

**Step 2: Append the note to each blocking tool's description**

For each of the five descriptions referenced above, append `\n\n${progressTokenNote()}` to the existing description string. For example, for `execute-command-kill-after`:

```ts
  `Execute a command and block ... rawMode/noEnter.\n\n${progressTokenNote()}`,
```

For `execute-command-wait-for-exit` (which has no `timeoutSeconds`), use a tailored note inline rather than `progressTokenNote()` if appropriate, e.g.:

```ts
  ` ... existing description ...\n\nWhen the client sends a \`progressToken\`, this server emits \`notifications/progress\` every ~25s during the wait so the client's per-request timer keeps resetting; long-running commands will not be aborted by the client timeout.`,
```

**Step 3: Compile to verify**

Run: `npx tsc --noEmit`
Expected: no errors.

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "Document progress-notification behavior in blocking tool descriptions"
```

---

## Task 10: Update README

**Files:**
- Modify: `README.md`

**Step 1: Add a new section**

Find the section that describes the `--client-timeout-seconds` flag / blocking-tool cap (search for `client-timeout` or `cap`). Immediately after that section, add:

```markdown
### Long-running tools and progress notifications

The blocking tools (`execute-command-kill-after`, `execute-command-wait-for-exit`,
`wait-for-pane-content`, `wait-for-pane-content-gone`, `sleep`) automatically
adapt to the MCP client's progress-notification capability:

- **Client sends a `progressToken`** (per MCP spec): tmux-mcp emits
  `notifications/progress` every ~25s during the wait. A spec-compliant client
  with `resetTimeoutOnProgress: true` resets its per-request timer on each
  notification, so long waits run without hitting the client's timeout. The
  server's own 59s cap is automatically lifted in this case — the requested
  `timeoutSeconds` (or `seconds`) is honored as-is.

- **Client does not send a token**: the 59s cap is enforced (configurable via
  `--client-timeout-seconds`). For longer work, use `execute-command-async`
  and poll with `get-command-result`.

Notifications are only emitted **after a successful tmux poll**, so a hang in
this server or its tmux subprocess correctly stops emitting and the client's
unresponsiveness check still works.

For per-server timeout configuration in opencode (anomalyco/opencode#8706),
set `mcp.tmux.timeout` in your opencode config.
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "Document progress-notification behavior for long-running tools"
```

---

## Task 11: Manual verification

This project has no automated test harness. Run these manual checks before declaring done.

**Step 1: Build**

Run: `npm run build` (or `npx tsc -p tsconfig.json`)
Expected: clean build, no errors.

**Step 2: Verify cap-skip when token present (positive path)**

Use any MCP client that sends `progressToken` and reads `notifications/progress` (e.g. opencode after PR #24964 lands, or a hand-written test harness using `@modelcontextprotocol/sdk`'s client).

Test 2a: `sleep { seconds: 180 }` over a transport configured with a 60s
client request timeout and `resetTimeoutOnProgress: true`. Expected: returns
"Slept for 180s" successfully; client logs ~7 progress notifications.

Test 2b: `wait-for-pane-content { paneId, text: "never-matches", timeoutSeconds: 300 }`.
Expected: returns the timeout error message after 300s; the client did not
abort the request first.

**Step 3: Verify cap enforcement when token absent (regression check)**

Use a client that does NOT send `progressToken` (current opencode behavior pre-#24964).
Test 3a: `sleep { seconds: 120 }`. Expected: rejected with the existing cap
error message exactly as before this change.

**Step 4: Verify hang detection is preserved**

With a token-sending client, start `wait-for-pane-content { paneId, text: "x", timeoutSeconds: 600 }`,
then `kill -STOP` the local tmux server.

Expected: `capturePaneContent` calls hang inside `pollPaneContent`, no further
notifications fire, the client's per-request timer eventually expires and
returns `MCP error -32001`. (`kill -CONT` to recover.)

**Step 5: Final commit if any small fixes were needed**

If verification surfaced bugs, fix them as small commits and re-run verification.
Once clean: declare done.

---

## Summary of files touched

| File | Tasks |
|------|-------|
| `src/progress.ts` | Task 1 (new) |
| `src/tmux.ts` | Tasks 2, 3 |
| `src/index.ts` | Tasks 4, 5, 6, 7, 8, 9 |
| `README.md` | Task 10 |
| `docs/plans/2026-05-06-progress-notifications-design.md` | (already committed) |
| `docs/plans/2026-05-06-progress-notifications-plan.md` | (this file) |
