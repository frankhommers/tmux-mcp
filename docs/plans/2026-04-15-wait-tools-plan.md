# Wait Tools Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add three new tools (`wait-for-pane-content`, `wait-for-pane-content-gone`, `sleep`) that let agents wait for pane content changes or simple delays.

**Architecture:** Polling-based: `wait-for-pane-content` and `wait-for-pane-content-gone` poll pane content via the existing `capturePaneContent()` function at configurable intervals. `sleep` is a simple timer. New functions added to `tmux.ts`, tool registrations in `index.ts`.

**Tech Stack:** TypeScript, Zod (parameter validation), existing tmux.ts module.

---

### Task 1: Add `waitForPaneContent` function to tmux.ts

**Files:**
- Modify: `src/tmux.ts` (append before the closing of file, after `downloadFile` at line 959)

**Step 1: Implement `waitForPaneContent`**

Add the following exported function at the end of `src/tmux.ts` (before the final empty line):

```typescript
/**
 * Poll pane content until a text or regex pattern appears.
 * Returns the matched line on success, or null on timeout.
 */
export async function waitForPaneContent(
  paneId: string,
  pattern: string,
  options: {
    regex?: boolean;
    timeoutSeconds: number;
    pollIntervalMs?: number;
    lines?: number;
  }
): Promise<{ found: true; matchedLine: string } | { found: false }> {
  const pollInterval = options.pollIntervalMs ?? 500;
  const deadline = Date.now() + options.timeoutSeconds * 1000;

  const matcher = options.regex ? new RegExp(pattern) : null;

  while (Date.now() < deadline) {
    const content = await capturePaneContent(paneId, options.lines ?? 200);
    const lines = content.split('\n');

    for (const line of lines) {
      if (matcher ? matcher.test(line) : line.includes(pattern)) {
        return { found: true, matchedLine: line };
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollInterval, remaining));
  }

  return { found: false };
}
```

**Step 2: Implement `waitForPaneContentGone`**

Add the following exported function right after `waitForPaneContent`:

```typescript
/**
 * Poll pane content until a text or regex pattern disappears.
 * Returns true when the pattern is no longer found, or false on timeout.
 */
export async function waitForPaneContentGone(
  paneId: string,
  pattern: string,
  options: {
    regex?: boolean;
    timeoutSeconds: number;
    pollIntervalMs?: number;
    lines?: number;
  }
): Promise<{ gone: true } | { gone: false }> {
  const pollInterval = options.pollIntervalMs ?? 500;
  const deadline = Date.now() + options.timeoutSeconds * 1000;

  const matcher = options.regex ? new RegExp(pattern) : null;

  while (Date.now() < deadline) {
    const content = await capturePaneContent(paneId, options.lines ?? 200);
    const lines = content.split('\n');

    let found = false;
    for (const line of lines) {
      if (matcher ? matcher.test(line) : line.includes(pattern)) {
        found = true;
        break;
      }
    }

    if (!found) {
      return { gone: true };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollInterval, remaining));
  }

  return { gone: false };
}
```

**Step 3: Build and verify no compilation errors**

Run: `npm run build`
Expected: Build succeeds with no errors.

**Step 4: Commit**

```bash
git add src/tmux.ts
git commit -m "Add waitForPaneContent and waitForPaneContentGone functions to tmux module"
```

---

### Task 2: Add `wait-for-pane-content` tool to index.ts

**Files:**
- Modify: `src/index.ts` (insert after the `file-download` tool registration, before `disableToolsByScope` at line 1108)

**Step 1: Add the tool registration**

Insert after line 1106 (the closing `);` of `file-download`):

```typescript
// Wait for pane content - Tool
server.tool(
  "wait-for-pane-content",
  "Wait for text or regex pattern to appear in pane content. Polls the currently visible pane content at regular intervals. Useful for waiting until a command produces specific output, a server becomes ready, or a prompt returns.",
  {
    paneId: z.string().describe("ID of the tmux pane"),
    text: z.string().describe("Text or regex pattern to wait for"),
    regex: z.boolean().optional().describe("Interpret 'text' as a regular expression. Default: false"),
    timeoutSeconds: z.number().describe("Maximum seconds to wait before returning a timeout error"),
    pollIntervalMs: z.number().optional().describe("How often to check pane content in milliseconds. Default: 500"),
    lines: z.string().optional().describe("Number of lines to capture from the pane. Default: visible pane content")
  },
  async ({ paneId, text, regex, timeoutSeconds, pollIntervalMs, lines }) => {
    try {
      if (isExcludedPane(paneId)) {
        return { content: [{ type: "text", text: `Access denied: pane ${paneId} is the agent's own pane and cannot be interacted with.` }], isError: true };
      }
      await assertInScope(paneId, 'pane');

      // Validate regex if provided
      if (regex) {
        try {
          new RegExp(text);
        } catch (e: any) {
          return { content: [{ type: "text", text: `Invalid regex pattern: ${e.message}` }], isError: true };
        }
      }

      const linesCount = lines ? parseInt(lines, 10) : undefined;
      const result = await tmux.waitForPaneContent(paneId, text, {
        regex,
        timeoutSeconds,
        pollIntervalMs,
        lines: linesCount,
      });

      if (result.found) {
        return { content: [{ type: "text", text: `Found: ${result.matchedLine}` }] };
      } else {
        return { content: [{ type: "text", text: `Timeout after ${timeoutSeconds}s: pattern not found in pane content` }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: "text", text: `Error waiting for pane content: ${error}` }], isError: true };
    }
  }
);
```

**Step 2: Build and verify**

Run: `npm run build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "Add wait-for-pane-content tool"
```

---

### Task 3: Add `wait-for-pane-content-gone` tool to index.ts

**Files:**
- Modify: `src/index.ts` (insert right after the `wait-for-pane-content` tool)

**Step 1: Add the tool registration**

Insert after the `wait-for-pane-content` tool closing `);`:

```typescript
// Wait for pane content gone - Tool
server.tool(
  "wait-for-pane-content-gone",
  "Wait for text or regex pattern to disappear from pane content. Polls the currently visible pane content at regular intervals. Checks only the visible content controlled by the 'lines' parameter, not full scrollback history. Text that has scrolled out of the capture window is considered 'gone'.",
  {
    paneId: z.string().describe("ID of the tmux pane"),
    text: z.string().describe("Text or regex pattern to wait for to disappear"),
    regex: z.boolean().optional().describe("Interpret 'text' as a regular expression. Default: false"),
    timeoutSeconds: z.number().describe("Maximum seconds to wait before returning a timeout error"),
    pollIntervalMs: z.number().optional().describe("How often to check pane content in milliseconds. Default: 500"),
    lines: z.string().optional().describe("Number of lines to capture from the pane. Default: visible pane content")
  },
  async ({ paneId, text, regex, timeoutSeconds, pollIntervalMs, lines }) => {
    try {
      if (isExcludedPane(paneId)) {
        return { content: [{ type: "text", text: `Access denied: pane ${paneId} is the agent's own pane and cannot be interacted with.` }], isError: true };
      }
      await assertInScope(paneId, 'pane');

      // Validate regex if provided
      if (regex) {
        try {
          new RegExp(text);
        } catch (e: any) {
          return { content: [{ type: "text", text: `Invalid regex pattern: ${e.message}` }], isError: true };
        }
      }

      const linesCount = lines ? parseInt(lines, 10) : undefined;
      const result = await tmux.waitForPaneContentGone(paneId, text, {
        regex,
        timeoutSeconds,
        pollIntervalMs,
        lines: linesCount,
      });

      if (result.gone) {
        return { content: [{ type: "text", text: "Pattern no longer found in pane content" }] };
      } else {
        return { content: [{ type: "text", text: `Timeout after ${timeoutSeconds}s: pattern still present in pane content` }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: "text", text: `Error waiting for pane content gone: ${error}` }], isError: true };
    }
  }
);
```

**Step 2: Build and verify**

Run: `npm run build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "Add wait-for-pane-content-gone tool"
```

---

### Task 4: Add `sleep` tool to index.ts

**Files:**
- Modify: `src/index.ts` (insert right after the `wait-for-pane-content-gone` tool)

**Step 1: Add the tool registration**

```typescript
// Sleep - Tool
server.tool(
  "sleep",
  "Wait for a specified number of seconds. No pane interaction. Useful as a delay between operations.",
  {
    seconds: z.number().describe("Number of seconds to wait. Must be greater than 0")
  },
  async ({ seconds }) => {
    try {
      if (seconds <= 0) {
        return { content: [{ type: "text", text: "Error: seconds must be greater than 0" }], isError: true };
      }
      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      return { content: [{ type: "text", text: `Slept for ${seconds}s` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error during sleep: ${error}` }], isError: true };
    }
  }
);
```

**Step 2: Build and verify**

Run: `npm run build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "Add sleep tool"
```

---

### Task 5: Update README.md

**Files:**
- Modify: `README.md`

**Step 1: Add documentation for the three new tools**

Add entries for `wait-for-pane-content`, `wait-for-pane-content-gone`, and `sleep` to the tools table in README.md, following the existing format.

**Step 2: Commit**

```bash
git add README.md
git commit -m "Document wait-for-pane-content, wait-for-pane-content-gone, and sleep tools in README"
```

---

### Task 6: Update version

**Files:**
- Modify: `package.json` (version field)
- Modify: `src/index.ts` (version in McpServer constructor, line 16)

**Step 1: Bump patch version from 0.2.2 to 0.2.3**

Update both locations.

**Step 2: Build**

Run: `npm run build`

**Step 3: Commit**

```bash
git add package.json src/index.ts
git commit -m "Bump version to 0.2.3"
```
