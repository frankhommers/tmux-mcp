#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as tmux from "./tmux.js";
import { initScope, assertInScope, isScopeActive, isInScope, addAllowedSession } from "./scope.js";

// Create MCP server
const server = new McpServer({
  name: "tmux-mcp",
  version: "0.2.2"
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
      const windows = await tmux.listWindows(sessionId);
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
      const panes = await tmux.listPanes(windowId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(panes, null, 2)
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
server.tool(
  "create-session",
  "Create a new tmux session",
  {
    name: z.string().describe("Name for the new tmux session")
  },
  async ({ name }) => {
    try {
      const session = await tmux.createSession(name);
      if (session) addAllowedSession(session.id);
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
server.tool(
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
server.tool(
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
    direction: z.enum(["horizontal", "vertical"]).optional().describe("Split direction: 'horizontal' (side by side) or 'vertical' (top/bottom). Default is 'vertical'"),
    size: z.number().min(1).max(99).optional().describe("Size of the new pane as percentage (1-99). Default is 50%")
  },
  async ({ paneId, direction, size }) => {
    try {
      await assertInScope(paneId, 'pane');
      const newPane = await tmux.splitPane(paneId, direction || 'vertical', size);
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

// Move window - Tool
server.tool(
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

// Execute command in pane - Tool
server.tool(
  "execute-command",
  "Execute a command in a tmux pane and get results. For interactive applications (REPLs, editors), use `rawMode=true`. IMPORTANT: When `rawMode=false` (default), avoid heredoc syntax (cat << EOF) and other multi-line constructs as they conflict with command wrapping. For file writing, prefer: printf 'content\\n' > file, echo statements, or write to temp files instead",
  {
    paneId: z.string().describe("ID of the tmux pane"),
    command: z.string().describe("Command to execute"),
    rawMode: z.boolean().optional().describe("Execute command without wrapper markers for REPL/interactive compatibility. Disables get-command-result status tracking. Use capture-pane after execution to verify command outcome."),
    noEnter: z.boolean().optional().describe("Send keystrokes without pressing Enter. For TUI navigation in apps like btop, vim, less. Supports special keys (Up, Down, Escape, Tab, etc.), modifier key sequences (C-c, C-z, C-d, M-a, etc.), and strings (sent char-by-char for proper filtering). Automatically applies rawMode. Use capture-pane after to see results.")
  },
  async ({ paneId, command, rawMode, noEnter }) => {
    try {
      await assertInScope(paneId, 'pane');
      // If noEnter is true, automatically apply rawMode
      const effectiveRawMode = noEnter || rawMode;
      const commandId = await tmux.executeCommand(paneId, command, effectiveRawMode, noEnter);

      if (effectiveRawMode) {
        const modeText = noEnter ? "Keys sent without Enter" : "Interactive command started (rawMode)";
        return {
          content: [{
            type: "text",
            text: `${modeText}.\n\nStatus tracking is disabled.\nUse 'capture-pane' with paneId '${paneId}' to verify the command outcome.\n\nCommand ID: ${commandId}`
          }]
        };
      }

      // Create the resource URI for this command's results
      const resourceUri = `tmux://command/${commandId}/result`;

      return {
        content: [{
          type: "text",
          text: `Command execution started.\n\nTo get results, subscribe to and read resource: ${resourceUri}\n\nStatus will change from 'pending' to 'completed' or 'error' when finished.`
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
          const windows = await tmux.listWindows(session.id);

          // For each window, get all panes
          for (const window of windows) {
            const panes = await tmux.listPanes(window.id);

            // For each pane, create a resource with descriptive name
            for (const pane of panes) {
              paneResources.push({
                name: `Pane: ${session.name} - ${pane.id} - ${pane.title} ${pane.active ? "(active)" : ""}`,
                uri: `tmux://pane/${pane.id}`,
                description: `Content from pane ${pane.id} - ${pane.title} in session ${session.name}`
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

async function main() {
  try {
    const { values } = parseArgs({
      options: {
        'shell-type': { type: 'string', default: 'bash', short: 's' },
        'scope': { type: 'string' }
      }
    });

    // Set shell configuration
    tmux.setShellConfig({
      type: values['shell-type'] as string
    });

    // Initialize scope
    const scopeValue = values['scope'] ?? process.env.TMUX_MCP_SCOPE ?? 'none';
    await initScope(scopeValue);

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
