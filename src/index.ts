#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as tmux from "./tmux.js";
import { initScope, assertInScope, isScopeActive, isInScope, isWindowScope, getScopeMode, initExcludeSelf, isExcludedPane, getExcludedPaneId, getSelfPaneId } from "./scope.js";

// Default split direction for split-pane and new-pane tools
let defaultSplitDirection: 'horizontal' | 'vertical' = 'horizontal';

// Create MCP server
const server = new McpServer({
  name: "tmux-mcp",
  version: "0.2.3"
}, {
  capabilities: {
    resources: {
      subscribe: true,
      listChanged: true
    },
    tools: {
      listChanged: true
    },
    logging: {}
  }
});

// List all tmux sessions - Tool
server.tool(
  "list-sessions",
  "List all active tmux sessions",
  {},
  async () => {
    try {
      let sessions = await tmux.listSessions();
      if (isScopeActive()) {
        const filtered = [];
        for (const s of sessions) {
          if (await isInScope(s.id, 'session')) filtered.push(s);
        }
        sessions = filtered;
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify(sessions, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error listing tmux sessions: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Find session by name - Tool
server.tool(
  "find-session",
  "Find a tmux session by name",
  {
    name: z.string().describe("Name of the tmux session to find")
  },
  async ({ name }) => {
    try {
      const session = await tmux.findSessionByName(name);
      if (session && !(await isInScope(session.id, 'session'))) {
        return {
          content: [{
            type: "text",
            text: `Session not found or not in scope: ${name}`
          }]
        };
      }
      return {
        content: [{
          type: "text",
          text: session ? JSON.stringify(session, null, 2) : `Session not found: ${name}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error finding tmux session: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Get current session - Tool
server.tool(
  "get-current-session",
  "Get the tmux session that the MCP server is running in (if any). Uses the $TMUX environment variable or tmux display-message to detect the current session.",
  {},
  async () => {
    try {
      const session = await tmux.getCurrentSession();
      if (session) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify(session, null, 2)
          }]
        };
      } else {
        return {
          content: [{
            type: "text",
            text: "Not running inside a tmux session"
          }]
        };
      }
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error getting current session: ${error}`
        }],
        isError: true
      };
    }
  }
);

// List windows in a session - Tool
server.tool(
  "list-windows",
  "List windows in a tmux session",
  {
    sessionId: z.string().describe("ID of the tmux session")
  },
  async ({ sessionId }) => {
    try {
      await assertInScope(sessionId, 'session');
      let windows = await tmux.listWindows(sessionId);
      if (isWindowScope()) {
        const filtered = [];
        for (const w of windows) {
          if (await isInScope(w.id, 'window')) filtered.push(w);
        }
        windows = filtered;
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify(windows, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error listing windows: ${error}`
        }],
        isError: true
      };
    }
  }
);

// List panes in a window - Tool
server.tool(
  "list-panes",
  "List panes in a tmux window",
  {
    windowId: z.string().describe("ID of the tmux window")
  },
  async ({ windowId }) => {
    try {
      await assertInScope(windowId, 'window');
      let panes = await tmux.listPanes(windowId);
      // Mark the agent's own pane so agents know it exists (e.g. for splitting),
      // even though they cannot interact with its content (capture, execute, etc.).
      const result = panes.map(p => {
        if (isExcludedPane(p.id)) {
          return { ...p, self: true };
        }
        return p;
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error listing panes: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Capture pane content - Tool
server.tool(
  "capture-pane",
  "Capture content from a tmux pane with configurable lines count and optional color preservation",
  {
    paneId: z.string().describe("ID of the tmux pane"),
    lines: z.string().optional().describe("Number of lines to capture"),
    colors: z.boolean().optional().describe("Include color/escape sequences for text and background attributes in output")
  },
  async ({ paneId, lines, colors }) => {
    try {
      if (isExcludedPane(paneId)) {
        return { content: [{ type: "text", text: `Access denied: pane ${paneId} is the agent's own pane and cannot be interacted with.` }], isError: true };
      }
      await assertInScope(paneId, 'pane');
      // Parse lines parameter if provided
      const linesCount = lines ? parseInt(lines, 10) : undefined;
      const includeColors = colors || false;
      const content = await tmux.capturePaneContent(paneId, linesCount, includeColors);
      return {
        content: [{
          type: "text",
          text: content || "No content captured"
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error capturing pane content: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Create new session - Tool
const createSessionTool = server.tool(
  "create-session",
  "Create a new tmux session",
  {
    name: z.string().describe("Name for the new tmux session")
  },
  async ({ name }) => {
    try {
      const session = await tmux.createSession(name);
      return {
        content: [{
          type: "text",
          text: session
            ? `Session created: ${JSON.stringify(session, null, 2)}`
            : `Failed to create session: ${name}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error creating session: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Create new window - Tool
const createWindowTool = server.tool(
  "create-window",
  "Create a new window in a tmux session",
  {
    sessionId: z.string().describe("ID of the tmux session"),
    name: z.string().describe("Name for the new window"),
    background: z.boolean().optional().describe("Create window in the background without switching focus to it (default: false)")
  },
  async ({ sessionId, name, background }) => {
    try {
      await assertInScope(sessionId, 'session');
      const window = await tmux.createWindow(sessionId, name, background);
      return {
        content: [{
          type: "text",
          text: window
            ? `Window created: ${JSON.stringify(window, null, 2)}`
            : `Failed to create window: ${name}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error creating window: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Kill session - Tool
server.tool(
  "kill-session",
  "Kill a tmux session by ID",
  {
    sessionId: z.string().describe("ID of the tmux session to kill")
  },
  async ({ sessionId }) => {
    try {
      await assertInScope(sessionId, 'session');
      await tmux.killSession(sessionId);
      return {
        content: [{
          type: "text",
          text: `Session ${sessionId} has been killed`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error killing session: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Kill window - Tool
const killWindowTool = server.tool(
  "kill-window",
  "Kill a tmux window by ID",
  {
    windowId: z.string().describe("ID of the tmux window to kill")
  },
  async ({ windowId }) => {
    try {
      await assertInScope(windowId, 'window');
      await tmux.killWindow(windowId);
      return {
        content: [{
          type: "text",
          text: `Window ${windowId} has been killed`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error killing window: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Rename window - Tool
server.tool(
  "rename-window",
  "Rename a tmux window",
  {
    windowId: z.string().describe("ID of the tmux window to rename"),
    name: z.string().describe("New name for the window")
  },
  async ({ windowId, name }) => {
    try {
      await assertInScope(windowId, 'window');
      await tmux.renameWindow(windowId, name);
      return {
        content: [{
          type: "text",
          text: `Window ${windowId} renamed to "${name}"`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error renaming window: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Rename pane - Tool
server.tool(
  "rename-pane",
  "Rename a tmux pane (set pane title)",
  {
    paneId: z.string().describe("ID of the tmux pane to rename"),
    name: z.string().describe("New title for the pane")
  },
  async ({ paneId, name }) => {
    try {
      if (isExcludedPane(paneId)) {
        return { content: [{ type: "text", text: `Access denied: pane ${paneId} is the agent's own pane and cannot be interacted with.` }], isError: true };
      }
      await assertInScope(paneId, 'pane');
      await tmux.renamePane(paneId, name);
      return {
        content: [{
          type: "text",
          text: `Pane ${paneId} renamed to "${name}"`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error renaming pane: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Kill pane - Tool
server.tool(
  "kill-pane",
  "Kill a tmux pane by ID",
  {
    paneId: z.string().describe("ID of the tmux pane to kill")
  },
  async ({ paneId }) => {
    try {
      if (isExcludedPane(paneId)) {
        return { content: [{ type: "text", text: `Access denied: pane ${paneId} is the agent's own pane and cannot be interacted with.` }], isError: true };
      }
      await assertInScope(paneId, 'pane');
      await tmux.killPane(paneId);
      return {
        content: [{
          type: "text",
          text: `Pane ${paneId} has been killed`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error killing pane: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Split pane - Tool
server.tool(
  "split-pane",
  "Split a tmux pane horizontally or vertically",
  {
    paneId: z.string().describe("ID of the tmux pane to split"),
    direction: z.enum(["horizontal", "vertical"]).optional().describe("Split direction: 'horizontal' (side by side) or 'vertical' (top/bottom). Defaults to server's --default-split-direction (horizontal if not set)"),
    size: z.number().min(1).max(99).optional().describe("Size of the new pane as percentage (1-99). Default is 50%")
  },
  async ({ paneId, direction, size }) => {
    try {
      // Allow splitting the excluded (self) pane: splitting doesn't interact
      // with the pane's content — it only creates a new sibling pane in the
      // same window. This is essential for scope=window when the agent's pane
      // is the only pane in the window (otherwise the agent has no pane to split).
      await assertInScope(paneId, 'pane');
      const newPane = await tmux.splitPane(paneId, direction || defaultSplitDirection, size);
      return {
        content: [{
          type: "text",
          text: newPane
            ? `Pane split successfully. New pane: ${JSON.stringify(newPane, null, 2)}`
            : `Failed to split pane ${paneId}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error splitting pane: ${error}`
        }],
        isError: true
      };
    }
  }
);

// New pane - Tool
// Convenience tool that creates a new pane without requiring a target pane ID.
// When no target is specified, it splits the agent's own pane (detected via
// $TMUX_PANE). This solves the bootstrapping problem in scope=window: the agent
// can always create a new pane even when its own pane is the only one in the window.
server.tool(
  "new-pane",
  "Create a new tmux pane by splitting an existing pane. When no target pane is specified, splits the agent's own pane. Returns the new pane's ID. This is the easiest way to create a new pane, especially when running in scoped mode.",
  {
    targetPaneId: z.string().optional().describe("ID of the pane to split. If omitted, splits the agent's own pane (detected via $TMUX_PANE)."),
    direction: z.enum(["horizontal", "vertical"]).optional().describe("Split direction: 'horizontal' (side by side) or 'vertical' (top/bottom). Defaults to server's --default-split-direction (horizontal if not set)"),
    size: z.number().min(1).max(99).optional().describe("Size of the new pane as percentage (1-99). Default is 50%")
  },
  async ({ targetPaneId, direction, size }) => {
    try {
      // Determine which pane to split
      let paneToSplit: string;
      if (targetPaneId) {
        // Explicit target: must be in scope (but allow excluded/self pane for splitting)
        await assertInScope(targetPaneId, 'pane');
        paneToSplit = targetPaneId;
      } else {
        // No target: use the agent's own pane from $TMUX_PANE
        const selfPane = getSelfPaneId();
        if (!selfPane) {
          return {
            content: [{ type: "text", text: "Cannot determine own pane: $TMUX_PANE is not set. Specify targetPaneId explicitly." }],
            isError: true
          };
        }
        paneToSplit = selfPane;
      }

      const newPane = await tmux.splitPane(paneToSplit, direction || defaultSplitDirection, size);
      if (newPane) {
        return {
          content: [{
            type: "text",
            text: `New pane created successfully: ${JSON.stringify(newPane, null, 2)}`
          }]
        };
      } else {
        return {
          content: [{ type: "text", text: `Failed to create new pane (split of ${paneToSplit} returned no result).` }],
          isError: true
        };
      }
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error creating new pane: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Move window - Tool
const moveWindowTool = server.tool(
  "move-window",
  "Move a tmux window to a different index or session",
  {
    source: z.string().optional().describe("Source window specification (format: session:window or window ID)"),
    destination: z.string().optional().describe("Destination window specification (format: session:window, session name, or window index)"),
    after: z.boolean().optional().describe("Move window to the next index after destination"),
    before: z.boolean().optional().describe("Move window to the next index before destination"),
    renumber: z.boolean().optional().describe("Renumber all windows in the session in sequential order"),
    detached: z.boolean().optional().describe("Do not select the moved window"),
    kill: z.boolean().optional().describe("Kill destination window if it exists")
  },
  async (args) => {
    try {
      if (args.source) await assertInScope(args.source, 'window');
      if (args.destination) await assertInScope(args.destination, 'window');
      await tmux.moveWindow(args);
      return {
        content: [{
          type: "text",
          text: `Window moved successfully`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error moving window: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Execute command in pane (fire-and-forget async) - Tool
server.tool(
  "execute-command-async",
  "Fire-and-forget: send a command to a tmux pane and return a commandId immediately. Use `get-command-result` to poll for completion and output. For interactive applications (REPLs, editors), use `rawMode=true`. IMPORTANT: When `rawMode=false` (default), avoid heredoc syntax (cat << EOF) and other multi-line constructs as they conflict with command wrapping. For file writing, prefer: printf 'content\\n' > file, echo statements, or write to temp files instead. If you want to block until the command finishes, use `execute-command-kill-after` or `execute-command-wait-for-exit` instead.",
  {
    paneId: z.string().describe("ID of the tmux pane"),
    command: z.string().describe("Command to execute"),
    rawMode: z.boolean().optional().describe("Execute command without wrapper markers for REPL/interactive compatibility. Disables get-command-result status tracking. Use capture-pane after execution to verify command outcome."),
    noEnter: z.boolean().optional().describe("Send keystrokes without pressing Enter. For TUI navigation in apps like btop, vim, less. Supports special keys (Up, Down, Escape, Tab, etc.), modifier key sequences (C-c, C-z, C-d, M-a, etc.), and strings (sent char-by-char for proper filtering). Automatically applies rawMode. Use capture-pane after to see results."),
    suppressHistory: z.boolean().optional().describe("Prepend a single space to the command line so shells with ignorespace/HIST_IGNORE_SPACE (bash/zsh) skip adding it to history. No effect on shells without that option or when rawMode/noEnter are set.")
  },
  async ({ paneId, command, rawMode, noEnter, suppressHistory }) => {
    try {
      if (isExcludedPane(paneId)) {
        return { content: [{ type: "text", text: `Access denied: pane ${paneId} is the agent's own pane and cannot be interacted with.` }], isError: true };
      }
      await assertInScope(paneId, 'pane');
      const effectiveRawMode = noEnter || rawMode;
      const commandId = await tmux.executeCommand(paneId, command, {
        rawMode: effectiveRawMode,
        noEnter,
        suppressHistory,
      });

      if (effectiveRawMode) {
        const modeText = noEnter ? "Keys sent without Enter" : "Interactive command started (rawMode)";
        return {
          content: [{
            type: "text",
            text: `${modeText}.\n\nStatus tracking is disabled.\nUse 'capture-pane' with paneId '${paneId}' to verify the command outcome.\n\nCommand ID: ${commandId}`
          }]
        };
      }

      const resourceUri = `tmux://command/${commandId}/result`;
      return {
        content: [{
          type: "text",
          text: `Command execution started.\n\nCommand ID: ${commandId}\nPoll with 'get-command-result', or subscribe to resource: ${resourceUri}\n\nStatus will change from 'pending' to 'completed' or 'error' when finished.`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error executing command: ${error}`
        }],
        isError: true
      };
    }
  }
);

function formatBlockingResult(res: tmux.BlockingResult): string {
  const lines = [
    `Status: ${res.status}`,
    `Exit code: ${res.exitCode === null ? 'n/a' : res.exitCode}`,
    `Command ID: ${res.commandId}`,
    '',
    '--- Output ---',
    res.output,
  ];
  if (res.status === 'timed_out_still_running') {
    lines.push('', 'NOTE: Ctrl-C was sent but the foreground process did not exit. The command is still running in the pane. Consider escalating (e.g. C-\\ via execute-command-async with rawMode, or kill-pane).');
  } else if (res.status === 'timed_out') {
    lines.push('', 'NOTE: Timed out; interrupt was disabled. The command is still running in the pane.');
  }
  return lines.join('\n');
}

// Execute command, block with timeout, kill on timeout - Tool
server.tool(
  "execute-command-kill-after",
  "Execute a command and block until it completes OR the timeout elapses. The command runs inside `sh -c` (POSIX, shell-agnostic) and inline-probes for GNU `timeout`/`gtimeout` on the target host; when present, the kernel handles the kill (exit code 124 or 137). When absent, falls back to Ctrl-C sequences and verifies the kill via pane_current_command. Returns one of: 'completed', 'error', 'timed_out' (if interruptOnTimeout=false), 'timed_out_interrupted' (kill confirmed), or 'timed_out_still_running' (command resisted the interrupt). Does not support rawMode/noEnter.",
  {
    paneId: z.string().describe("ID of the tmux pane"),
    command: z.string().describe("Command to execute"),
    timeoutSeconds: z.number().positive().describe("Maximum seconds to wait before timing out"),
    pollIntervalMs: z.number().positive().optional().describe("How often to check for completion. Default: 500"),
    interruptOnTimeout: z.boolean().optional().describe("Send Ctrl-C on timeout. Default: true"),
    interruptCount: z.number().int().positive().optional().describe("How many Ctrl-C's to send. Default: 3"),
    interruptIntervalMs: z.number().nonnegative().optional().describe("Delay between Ctrl-C's. Default: 200"),
    postInterruptWaitMs: z.number().nonnegative().optional().describe("Wait time after last Ctrl-C before capturing final output and checking kill. Default: 500"),
    suppressHistory: z.boolean().optional().describe("Prepend a single space so shells with ignorespace/HIST_IGNORE_SPACE (bash/zsh) skip adding the line to history."),
  },
  async (args) => {
    try {
      if (isExcludedPane(args.paneId)) {
        return { content: [{ type: "text", text: `Access denied: pane ${args.paneId} is the agent's own pane and cannot be interacted with.` }], isError: true };
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
      });
      return { content: [{ type: "text", text: formatBlockingResult(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error executing command: ${error}` }], isError: true };
    }
  }
);

// Execute command, block until completion (no timeout) - Tool
server.tool(
  "execute-command-wait-for-exit",
  "Execute a command and block until it completes. No timeout — will wait indefinitely. Returns 'completed' or 'error' with exit code and output. Does not support rawMode/noEnter.",
  {
    paneId: z.string().describe("ID of the tmux pane"),
    command: z.string().describe("Command to execute"),
    pollIntervalMs: z.number().positive().optional().describe("How often to check for completion. Default: 500"),
    suppressHistory: z.boolean().optional().describe("Prepend a single space so shells with ignorespace/HIST_IGNORE_SPACE (bash/zsh) skip adding the line to history."),
  },
  async ({ paneId, command, pollIntervalMs, suppressHistory }) => {
    try {
      if (isExcludedPane(paneId)) {
        return { content: [{ type: "text", text: `Access denied: pane ${paneId} is the agent's own pane and cannot be interacted with.` }], isError: true };
      }
      await assertInScope(paneId, 'pane');
      const result = await tmux.runBlocking(paneId, command, { pollIntervalMs, suppressHistory });
      return { content: [{ type: "text", text: formatBlockingResult(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error executing command: ${error}` }], isError: true };
    }
  }
);

// Get command result - Tool
server.tool(
  "get-command-result",
  "Get the result of an executed command",
  {
    commandId: z.string().describe("ID of the executed command")
  },
  async ({ commandId }) => {
    try {
      // Check and update command status
      const command = await tmux.checkCommandStatus(commandId);

      if (!command) {
        return {
          content: [{
            type: "text",
            text: `Command not found: ${commandId}`
          }],
          isError: true
        };
      }

      // Format the response based on command status
      let resultText;
      if (command.status === 'pending') {
        if (command.result) {
          resultText = `Status: ${command.status}\nCommand: ${command.command}\n\n--- Message ---\n${command.result}`;
        } else {
          resultText = `Command still executing...\nStarted: ${command.startTime.toISOString()}\nCommand: ${command.command}`;
        }
      } else {
        resultText = `Status: ${command.status}\nExit code: ${command.exitCode}\nCommand: ${command.command}\n\n--- Output ---\n${command.result}`;
      }

      return {
        content: [{
          type: "text",
          text: resultText
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error retrieving command result: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Capture last command output (OSC 133) - Tool
server.tool(
  "capture-last-output",
  "Capture the output of the Nth-most-recent command in a pane using OSC 133 shell integration marks. Returns only stdout/stderr without the prompt or command line. Requires the shell to have OSC 133 integration enabled.",
  {
    paneId: z.string().describe("Target pane ID (e.g. %0)"),
    n: z.number().min(1).optional().describe("Which command's output to capture (1 = most recent, 2 = second most recent, etc.). Default: 1")
  },
  async ({ paneId, n }) => {
    try {
      if (isExcludedPane(paneId)) {
        return { content: [{ type: "text", text: `Access denied: pane ${paneId} is the agent's own pane and cannot be interacted with.` }], isError: true };
      }
      await assertInScope(paneId, 'pane');
      const output = await tmux.captureLastOutput(paneId, n ?? 1);
      return {
        content: [{
          type: "text",
          text: output || "No output captured"
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error capturing last output: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Capture last command line (OSC 133) - Tool
server.tool(
  "capture-last-command",
  "Capture the command line (prompt + user input) of the Nth-most-recent command using OSC 133 marks. Includes the PS1 prompt prefix. Requires OSC 133 shell integration.",
  {
    paneId: z.string().describe("Target pane ID (e.g. %0)"),
    n: z.number().min(1).optional().describe("Which command to capture (1 = most recent, 2 = second most recent, etc.). Default: 1")
  },
  async ({ paneId, n }) => {
    try {
      if (isExcludedPane(paneId)) {
        return { content: [{ type: "text", text: `Access denied: pane ${paneId} is the agent's own pane and cannot be interacted with.` }], isError: true };
      }
      await assertInScope(paneId, 'pane');
      const command = await tmux.captureLastCommand(paneId, n ?? 1);
      return {
        content: [{
          type: "text",
          text: command || "No command captured"
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error capturing last command: ${error}`
        }],
        isError: true
      };
    }
  }
);


// Expose tmux session list as a resource
server.resource(
  "Tmux Sessions",
  "tmux://sessions",
  async () => {
    try {
      let sessions = await tmux.listSessions();
      if (isScopeActive()) {
        const filtered = [];
        for (const s of sessions) {
          if (await isInScope(s.id, 'session')) filtered.push(s);
        }
        sessions = filtered;
      }
      return {
        contents: [{
          uri: "tmux://sessions",
          text: JSON.stringify(sessions.map(session => ({
            id: session.id,
            name: session.name,
            attached: session.attached,
            windows: session.windows
          })), null, 2)
        }]
      };
    } catch (error) {
      return {
        contents: [{
          uri: "tmux://sessions",
          text: `Error listing tmux sessions: ${error}`
        }]
      };
    }
  }
);

// Expose pane content as a resource
server.resource(
  "Tmux Pane Content",
  new ResourceTemplate("tmux://pane/{paneId}", {
    list: async () => {
      try {
        // Get all sessions
        let sessions = await tmux.listSessions();
        if (isScopeActive()) {
          const filtered = [];
          for (const s of sessions) {
            if (await isInScope(s.id, 'session')) filtered.push(s);
          }
          sessions = filtered;
        }
        const paneResources = [];

        // For each session, get all windows
        for (const session of sessions) {
          let windows = await tmux.listWindows(session.id);
          if (isWindowScope()) {
            const filteredWindows = [];
            for (const w of windows) {
              if (await isInScope(w.id, 'window')) filteredWindows.push(w);
            }
            windows = filteredWindows;
          }

          // For each window, get all panes
          for (const window of windows) {
            const panes = await tmux.listPanes(window.id);

            // Include the agent's own pane in the listing so agents know it exists
            // (e.g. for splitting), even though its content is not readable.
            for (const pane of panes) {
              const isSelf = isExcludedPane(pane.id);
              paneResources.push({
                name: `Pane: ${session.name} - ${pane.id} - ${pane.title} ${pane.active ? "(active)" : ""}${isSelf ? " (self)" : ""}`,
                uri: `tmux://pane/${pane.id}`,
                description: isSelf
                  ? `Agent's own pane ${pane.id} in session ${session.name} (content not readable, but can be split)`
                  : `Content from pane ${pane.id} - ${pane.title} in session ${session.name}`
              });
            }
          }
        }

        return {
          resources: paneResources
        };
      } catch (error) {
        server.server.sendLoggingMessage({
          level: 'error',
          data: `Error listing panes: ${error}`
        });

        return { resources: [] };
      }
    }
  }),
  async (uri, { paneId }) => {
    try {
      // Ensure paneId is a string
      const paneIdStr = Array.isArray(paneId) ? paneId[0] : paneId;
      if (isExcludedPane(paneIdStr)) {
        return { contents: [{ uri: uri.href, text: `Access denied: pane ${paneIdStr} is the agent's own pane and cannot be interacted with.` }] };
      }
      await assertInScope(paneIdStr, 'pane');
      // Default to no colors for resources to maintain clean programmatic access
      const content = await tmux.capturePaneContent(paneIdStr, 200, false);
      return {
        contents: [{
          uri: uri.href,
          text: content || "No content captured"
        }]
      };
    } catch (error) {
      return {
        contents: [{
          uri: uri.href,
          text: `Error capturing pane content: ${error}`
        }]
      };
    }
  }
);

// Create dynamic resource for command executions
server.resource(
  "Command Execution Result",
  new ResourceTemplate("tmux://command/{commandId}/result", {
    list: async () => {
      // Only list active commands that aren't too old
      tmux.cleanupOldCommands(10); // Clean commands older than 10 minutes

      const resources = [];
      for (const id of tmux.getActiveCommandIds()) {
        const command = tmux.getCommand(id);
        if (command) {
          resources.push({
            name: `Command: ${command.command.substring(0, 30)}${command.command.length > 30 ? '...' : ''}`,
            uri: `tmux://command/${id}/result`,
            description: `Execution status: ${command.status}`
          });
        }
      }

      return { resources };
    }
  }),
  async (uri, { commandId }) => {
    try {
      // Ensure commandId is a string
      const commandIdStr = Array.isArray(commandId) ? commandId[0] : commandId;

      // Check command status
      const command = await tmux.checkCommandStatus(commandIdStr);

      if (!command) {
        return {
          contents: [{
            uri: uri.href,
            text: `Command not found: ${commandIdStr}`
          }]
        };
      }

      // Format the response based on command status
      let resultText;
      if (command.status === 'pending') {
        // For rawMode commands, we set a result message while status remains 'pending'
        // since we can't track their actual completion
        if (command.result) {
          resultText = `Status: ${command.status}\nCommand: ${command.command}\n\n--- Message ---\n${command.result}`;
        } else {
          resultText = `Command still executing...\nStarted: ${command.startTime.toISOString()}\nCommand: ${command.command}`;
        }
      } else {
        resultText = `Status: ${command.status}\nExit code: ${command.exitCode}\nCommand: ${command.command}\n\n--- Output ---\n${command.result}`;
      }

      return {
        contents: [{
          uri: uri.href,
          text: resultText
        }]
      };
    } catch (error) {
      return {
        contents: [{
          uri: uri.href,
          text: `Error retrieving command result: ${error}`
        }]
      };
    }
  }
);

// File upload - Host/inline -> Pane
server.tool(
  "file-upload",
  "Upload a file or inline content to a tmux pane. The content is gzip-compressed and base64-encoded on the host, sent as a single shell command, and decoded in the pane. Works over SSH/docker/any remote shell. Max ~128KB compressed payload (text files up to ~500KB thanks to gzip compression). Use scp/rsync for larger files.",
  {
    paneId: z.string().describe("ID of the tmux pane"),
    destinationPath: z.string().describe("Path where the file will be written in the pane"),
    sourcePath: z.string().optional().describe("Local file path on the MCP host. Either sourcePath or content must be provided."),
    content: z.string().optional().describe("Inline text content to upload. Either sourcePath or content must be provided."),
    permissions: z.string().optional().describe("chmod permissions to set, e.g. '755' for executable scripts"),
    suppressHistory: z.boolean().optional().describe("Prepend space to avoid shell history"),
  },
  async (args) => {
    try {
      if (isExcludedPane(args.paneId)) {
        return { content: [{ type: "text", text: `Access denied: pane ${args.paneId} is the agent's own pane and cannot be interacted with.` }], isError: true };
      }
      await assertInScope(args.paneId, 'pane');
      const result = await tmux.uploadFile({
        paneId: args.paneId,
        destinationPath: args.destinationPath,
        sourcePath: args.sourcePath,
        content: args.content,
        permissions: args.permissions,
        suppressHistory: args.suppressHistory,
      });
      return {
        content: [{ type: "text", text: `Status: ${result.status}\n${result.message}\nBytes transferred: ${result.bytesTransferred}` }],
        isError: result.status === 'error',
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error uploading file: ${error}` }], isError: true };
    }
  }
);

// File download - Pane -> Host
server.tool(
  "file-download",
  "Download a file from a tmux pane to the local host or return its content. The file is gzip-compressed and base64-encoded in the pane, captured via command output, and decoded on the host. Works over SSH/docker/any remote shell. If destinationPath is omitted, the file content is returned as text. Max ~128KB compressed payload.",
  {
    paneId: z.string().describe("ID of the tmux pane"),
    sourcePath: z.string().describe("Path of the file in the pane"),
    destinationPath: z.string().optional().describe("Local path to write the file to. If omitted, content is returned as text."),
    suppressHistory: z.boolean().optional().describe("Prepend space to avoid shell history"),
  },
  async (args) => {
    try {
      if (isExcludedPane(args.paneId)) {
        return { content: [{ type: "text", text: `Access denied: pane ${args.paneId} is the agent's own pane and cannot be interacted with.` }], isError: true };
      }
      await assertInScope(args.paneId, 'pane');
      const result = await tmux.downloadFile({
        paneId: args.paneId,
        sourcePath: args.sourcePath,
        destinationPath: args.destinationPath,
        suppressHistory: args.suppressHistory,
      });
      if (result.status === 'error') {
        return { content: [{ type: "text", text: `Status: error\n${result.message}` }], isError: true };
      }
      let text = `Status: completed\n${result.message}\nBytes transferred: ${result.bytesTransferred}`;
      if (result.content !== undefined) {
        text += `\n\n--- Content ---\n${result.content}`;
      }
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error downloading file: ${error}` }], isError: true };
    }
  }
);

// ── wait-for-pane-content ──────────────────────────────────────────────
server.tool(
  "wait-for-pane-content",
  "Wait for text or regex pattern to appear in pane content. Polls the currently visible pane content at regular intervals. Useful for waiting until a command produces specific output, a server becomes ready, or a prompt returns.",
  {
    paneId: z.string().describe("ID of the tmux pane"),
    text: z.string().describe("Text or regex pattern to wait for"),
    regex: z.boolean().optional().describe("Interpret 'text' as a regular expression. Default: false"),
    timeoutSeconds: z.number().positive().describe("Maximum seconds to wait before returning a timeout error"),
    pollIntervalMs: z.number().positive().optional().describe("How often to check pane content in milliseconds. Default: 500"),
    lines: z.string().optional().describe("Number of lines to capture from the pane. Default: visible pane content")
  },
  async ({ paneId, text, regex, timeoutSeconds, pollIntervalMs, lines }) => {
    try {
      if (isExcludedPane(paneId)) {
        return { content: [{ type: "text", text: `Access denied: pane ${paneId} is the agent's own pane and cannot be interacted with.` }], isError: true };
      }
      await assertInScope(paneId, 'pane');

      if (regex) {
        try { new RegExp(text); } catch (e: any) {
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

// ── wait-for-pane-content-gone ─────────────────────────────────────────
server.tool(
  "wait-for-pane-content-gone",
  "Wait for text or regex pattern to disappear from pane content. Polls the currently visible pane content at regular intervals. Checks only the visible content controlled by the 'lines' parameter, not full scrollback history. Text that has scrolled out of the capture window is considered 'gone'.",
  {
    paneId: z.string().describe("ID of the tmux pane"),
    text: z.string().describe("Text or regex pattern to wait for to disappear"),
    regex: z.boolean().optional().describe("Interpret 'text' as a regular expression. Default: false"),
    timeoutSeconds: z.number().positive().describe("Maximum seconds to wait before returning a timeout error"),
    pollIntervalMs: z.number().positive().optional().describe("How often to check pane content in milliseconds. Default: 500"),
    lines: z.string().optional().describe("Number of lines to capture from the pane. Default: visible pane content")
  },
  async ({ paneId, text, regex, timeoutSeconds, pollIntervalMs, lines }) => {
    try {
      if (isExcludedPane(paneId)) {
        return { content: [{ type: "text", text: `Access denied: pane ${paneId} is the agent's own pane and cannot be interacted with.` }], isError: true };
      }
      await assertInScope(paneId, 'pane');

      if (regex) {
        try { new RegExp(text); } catch (e: any) {
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

// ── sleep ──────────────────────────────────────────────────────────────
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

/**
 * Disable tools that are not applicable for the current scope mode.
 * Called once at startup after initScope().
 *
 * - session scope: disable create-session
 * - window scope: disable create-session, create-window, kill-window, move-window
 */
function disableToolsByScope(): void {
  const mode = getScopeMode();
  if (mode === 'none') return;

  // Both session and window scope: cannot create new sessions
  createSessionTool.disable();

  if (mode === 'window') {
    // Window scope: cannot create/kill/move windows
    createWindowTool.disable();
    killWindowTool.disable();
    moveWindowTool.disable();
  }
}

async function main() {
  try {
    const { values } = parseArgs({
      options: {
        'scope': { type: 'string' },
        'include-current-pane': { type: 'boolean', default: false },
        'default-split-direction': { type: 'string' }
      }
    });

    // Initialize scope mode (session/window resolved lazily on first tool use)
    const scopeValue = values['scope'] ?? process.env.TMUX_MCP_SCOPE ?? 'none';
    initScope(scopeValue);

    // Disable tools that don't apply to the active scope
    disableToolsByScope();

    // Initialize exclude-self (excludes the agent's own pane by default)
    initExcludeSelf(values['include-current-pane'] as boolean);

    // Initialize default split direction
    const splitDir = values['default-split-direction'] ?? process.env.TMUX_MCP_DEFAULT_SPLIT_DIRECTION;
    if (splitDir) {
      if (splitDir !== 'horizontal' && splitDir !== 'vertical') {
        console.error(`Invalid --default-split-direction: '${splitDir}'. Must be 'horizontal' or 'vertical'.`);
        process.exit(1);
      }
      defaultSplitDirection = splitDir;
    }

    // Start the MCP server
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    console.error("Failed to start MCP server:", error);
    process.exit(1);
  }
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
