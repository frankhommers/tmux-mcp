import { execFile as execFileCallback } from "child_process";
import { promisify } from "util";
import { v4 as uuidv4 } from 'uuid';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';

const execFile = promisify(execFileCallback);

// Basic interfaces for tmux objects
export interface TmuxSession {
  id: string;
  name: string;
  attached: boolean;
  windows: number;
}

export interface TmuxWindow {
  id: string;
  name: string;
  active: boolean;
  sessionId: string;
}

export interface TmuxPane {
  id: string;
  windowId: string;
  active: boolean;
  title: string;
}

interface CommandExecution {
  id: string;
  paneId: string;
  command: string;
  status: 'pending' | 'completed' | 'error';
  startTime: Date;
  result?: string;
  exitCode?: number;
  rawMode?: boolean;
}

/**
 * Maximum base64 payload size in characters.
 * Conservative limit for tmux send-keys (~128KB).
 */
const MAX_BASE64_PAYLOAD = 131072;

/**
 * Execute a tmux command and return the result.
 * Uses execFile to pass arguments directly without shell interpretation,
 * preventing command injection.
 */
export async function executeTmux(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile('tmux', args);
    return stdout.trim();
  } catch (error: any) {
    throw new Error(`Failed to execute tmux command: ${error.message}`);
  }
}

/**
 * Check if tmux server is running
 */
export async function isTmuxRunning(): Promise<boolean> {
  try {
    await executeTmux(['list-sessions', '-F', '#{session_name}']);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * List all tmux sessions
 */
export async function listSessions(): Promise<TmuxSession[]> {
  const format = "#{session_id}:#{session_name}:#{?session_attached,1,0}:#{session_windows}";
  const output = await executeTmux(['list-sessions', '-F', format]);

  if (!output) return [];

  return output.split('\n').map(line => {
    const [id, name, attached, windows] = line.split(':');
    return {
      id,
      name,
      attached: attached === '1',
      windows: parseInt(windows, 10)
    };
  });
}

/**
 * Find a session by name
 */
export async function findSessionByName(name: string): Promise<TmuxSession | null> {
  try {
    const sessions = await listSessions();
    return sessions.find(session => session.name === name) || null;
  } catch (error) {
    return null;
  }
}

/**
 * Get the current tmux session that this process is running in (if any)
 */
export async function getCurrentSession(): Promise<TmuxSession | null> {
  // First, try using the $TMUX environment variable
  const tmuxEnv = process.env.TMUX;
  if (tmuxEnv) {
    // Format: /tmp/tmux-1000/default,12345,6
    // The last number is the session ID
    const parts = tmuxEnv.split(',');
    if (parts.length >= 3) {
      const sessions = await listSessions();
      // Session IDs in tmux are prefixed with $, e.g., "$6"
      const sessionId = `$${parts[parts.length - 1]}`;
      return sessions.find(s => s.id === sessionId) || null;
    }
  }

  // Fallback: try tmux display-message (works if running inside tmux)
  try {
    const sessionName = await executeTmux(['display-message', '-p', '#S']);
    if (sessionName) {
      const sessions = await listSessions();
      return sessions.find(s => s.name === sessionName) || null;
    }
  } catch {
    // Not in a tmux session
  }

  return null;
}

/**
 * List windows in a session
 */
export async function listWindows(sessionId: string): Promise<TmuxWindow[]> {
  const format = "#{window_id}:#{window_name}:#{?window_active,1,0}";
  const output = await executeTmux(['list-windows', '-t', sessionId, '-F', format]);

  if (!output) return [];

  return output.split('\n').map(line => {
    const [id, name, active] = line.split(':');
    return {
      id,
      name,
      active: active === '1',
      sessionId
    };
  });
}

/**
 * Rename a window
 */
export async function renameWindow(windowId: string, newName: string): Promise<void> {
  await executeTmux(['rename-window', '-t', windowId, newName]);
}

/**
 * Rename a pane (set pane title)
 */
export async function renamePane(paneId: string, newTitle: string): Promise<void> {
  await executeTmux(['select-pane', '-t', paneId, '-T', newTitle]);
}

/**
 * List panes in a window
 */
export async function listPanes(windowId: string): Promise<TmuxPane[]> {
  const format = "#{pane_id}:#{pane_title}:#{?pane_active,1,0}";
  const output = await executeTmux(['list-panes', '-t', windowId, '-F', format]);

  if (!output) return [];

  return output.split('\n').map(line => {
    const [id, title, active] = line.split(':');
    return {
      id,
      windowId,
      title: title,
      active: active === '1'
    };
  });
}

/**
 * Capture content from a specific pane, by default the latest 200 lines.
 *
 * Note: tmux's `-S -N` flag means "start N lines above the visible pane",
 * but the visible pane content is always included, so the raw output is
 * approximately N + pane_height lines. We trim to exactly N lines here.
 */
export async function capturePaneContent(paneId: string, lines: number = 200, includeColors: boolean = false): Promise<string> {
  const args = ['capture-pane', '-p'];
  if (includeColors) args.push('-e');
  args.push('-t', paneId, '-S', `-${lines}`, '-E', '-');
  const content = await executeTmux(args);
  const allLines = content.split('\n');
  if (allLines.length > lines) {
    return allLines.slice(-lines).join('\n');
  }
  return content;
}

/**
 * Create a new tmux session
 */
export async function createSession(name: string): Promise<TmuxSession | null> {
  await executeTmux(['new-session', '-d', '-s', name]);
  return findSessionByName(name);
}

/**
 * Create a new window in a session
 */
export async function createWindow(sessionId: string, name: string, background: boolean = false): Promise<TmuxWindow | null> {
  const args = ['new-window'];
  if (background) args.push('-d');
  args.push('-t', sessionId, '-n', name);
  await executeTmux(args);
  const windows = await listWindows(sessionId);
  return windows.find(window => window.name === name) || null;
}

/**
 * Kill a tmux session by ID
 */
export async function killSession(sessionId: string): Promise<void> {
  await executeTmux(['kill-session', '-t', sessionId]);
}

/**
 * Kill a tmux window by ID
 */
export async function killWindow(windowId: string): Promise<void> {
  await executeTmux(['kill-window', '-t', windowId]);
}

/**
 * Kill a tmux pane by ID
 */
export async function killPane(paneId: string): Promise<void> {
  await executeTmux(['kill-pane', '-t', paneId]);
}

export interface MoveWindowOptions {
  source?: string;
  destination?: string;
  after?: boolean;
  before?: boolean;
  renumber?: boolean;
  detached?: boolean;
  kill?: boolean;
}

/**
 * Move a window to a different index or session
 */
export async function moveWindow(options: MoveWindowOptions): Promise<void> {
  const args = ['move-window'];

  if (options.after) args.push('-a');
  if (options.before) args.push('-b');
  if (options.renumber) args.push('-r');
  if (options.detached) args.push('-d');
  if (options.kill) args.push('-k');

  if (options.source) args.push('-s', options.source);
  if (options.destination) args.push('-t', options.destination);

  await executeTmux(args);
}

/**
 * Split a tmux pane horizontally or vertically
 */
export async function splitPane(
  targetPaneId: string,
  direction: 'horizontal' | 'vertical' = 'vertical',
  size?: number
): Promise<TmuxPane | null> {
  // Build the split-window args
  const args = ['split-window', direction === 'horizontal' ? '-h' : '-v', '-t', targetPaneId];

  // Add size if specified (as percentage)
  if (size !== undefined && size > 0 && size < 100) {
    args.push('-p', String(size));
  }

  // Execute the split command
  await executeTmux(args);

  // Get the window ID from the target pane to list all panes
  const windowInfo = await executeTmux(['display-message', '-p', '-t', targetPaneId, '#{window_id}']);

  // List all panes in the window to find the newly created one
  const panes = await listPanes(windowInfo);

  // The newest pane is typically the last one in the list
  return panes.length > 0 ? panes[panes.length - 1] : null;
}

// Map to track ongoing command executions
const activeCommands = new Map<string, CommandExecution>();

const startMarkerText = 'TMUX_MCP_START';
const endMarkerPrefix = "TMUX_MCP_DONE_";

export interface ExecuteCommandOptions {
  rawMode?: boolean;
  noEnter?: boolean;
  timeoutSeconds?: number;
  suppressHistory?: boolean;
  // When set, used in the "# Running: ..." banner instead of the actual
  // command. Useful for tools that send huge inline payloads (file-upload,
  // file-download) and don't want the payload duplicated in the banner.
  displayLabel?: string;
}

// Execute a command in a tmux pane and track its execution
export async function executeCommand(
  paneId: string,
  command: string,
  rawModeOrOpts?: boolean | ExecuteCommandOptions,
  noEnter?: boolean,
): Promise<string> {
  const opts: ExecuteCommandOptions = typeof rawModeOrOpts === 'object' && rawModeOrOpts !== null
    ? rawModeOrOpts
    : { rawMode: rawModeOrOpts, noEnter };
  const rawMode = opts.rawMode;
  const effectiveNoEnter = opts.noEnter;

  // Guard against LLM agents wrapping the command in unnecessary quotes.
  const sanitizedCommand = (rawMode || effectiveNoEnter) ? command : stripOuterQuotes(command);

  // Generate unique ID for this command execution
  const commandId = uuidv4();
  const commandExec: CommandExecution = {
    id: commandId,
    paneId,
    command: sanitizedCommand,
    status: 'pending',
    startTime: new Date(),
    rawMode: rawMode || effectiveNoEnter
  }

   // Store command in tracking map
  activeCommands.set(commandId, commandExec);

  let fullCommand: string;
  if (rawMode || effectiveNoEnter) {
    fullCommand = command;
  } else {
    fullCommand = buildWrappedCommand(commandExec, sanitizedCommand, opts.timeoutSeconds, opts.suppressHistory, opts.displayLabel);
  }

  // Send the command to the tmux pane
  if (effectiveNoEnter) {
    // Check if this is a special key (e.g., Up, Down, Left, Right, Escape, Tab, etc.)
    // Special keys in tmux are typically capitalized or have special names
    const specialKeys = ['Up', 'Down', 'Left', 'Right', 'Escape', 'Tab', 'Enter', 'Space',
      'BSpace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
      'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'];

    // Also match tmux modifier key sequences like C-c, C-z, M-a, S-Up, etc.
    const isModifierKey = /^[CMS]-/.test(fullCommand);

    if (specialKeys.includes(fullCommand) || isModifierKey) {
      // Send special key or modifier sequence as-is (unquoted) so tmux interprets it
      await executeTmux(['send-keys', '-t', paneId, fullCommand]);
    } else {
      // For regular text, send each character individually to ensure proper processing
      // This handles both single characters (like 'q', 'f') and strings (like 'beam')
      for (const char of fullCommand) {
        await executeTmux(['send-keys', '-t', paneId, char]);
      }
    }
  } else {
    await executeTmux(['send-keys', '-t', paneId, fullCommand, 'Enter']);
  }

  return commandId;
}

export async function checkCommandStatus(commandId: string): Promise<CommandExecution | null> {
  const command = activeCommands.get(commandId);
  if (!command) return null;

  if (command.status !== 'pending') return command;

  const content = await capturePaneContent(command.paneId, 3000);

  if (command.rawMode) {
    command.result = 'Status tracking unavailable for rawMode commands. Use capture-pane to monitor interactive apps instead.';
    return command;
  }

  const startMarkerText = getStartMarkerText(command)
  const endMarkerPrefix = getEndMarkerPrefix(command)

  // Find the last occurrence of the markers
  const startIndex = content.lastIndexOf(startMarkerText);
  const endIndex = content.lastIndexOf(endMarkerPrefix);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    command.result = "Command output could not be captured properly";
    return command;
  }

  // Extract exit code from the end marker line
  const endLine = content.substring(endIndex).split('\n')[0];
  const endMarkerRegex = new RegExp(`${endMarkerPrefix}(\\d+)`);
  const exitCodeMatch = endLine.match(endMarkerRegex);

  if (exitCodeMatch) {
    const exitCode = parseInt(exitCodeMatch[1], 10);

    command.status = exitCode === 0 ? 'completed' : 'error';
    command.exitCode = exitCode;

    // Extract output between the start and end markers
    const outputStart = startIndex + startMarkerText.length;
    const outputContent = content.substring(outputStart, endIndex);

    // Skip the first newline after the start marker if present, then trim
    const firstNewlineIndex = outputContent.indexOf('\n');
    command.result = firstNewlineIndex !== -1 
      ? outputContent.substring(firstNewlineIndex + 1).trim()
      : outputContent.trim();

    // Update in map
    activeCommands.set(commandId, command);
  }

  return command;
}

// Get command by ID
export function getCommand(commandId: string): CommandExecution | null {
  return activeCommands.get(commandId) || null;
}

/**
 * Get the name of the foreground process currently attached to the pane's tty.
 * When the shell is idle this is the shell name (bash/zsh/fish/…); while a
 * command runs, it's that command's name.
 */
export async function getPaneCurrentCommand(paneId: string): Promise<string> {
  return executeTmux(['display-message', '-p', '-t', paneId, '#{pane_current_command}']);
}

/**
 * Send a single Ctrl-C key event to a pane.
 */
export async function sendInterrupt(paneId: string): Promise<void> {
  await executeTmux(['send-keys', '-t', paneId, 'C-c']);
}

function shellSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Strip unnecessary outer quotes from a command string.
 *
 * LLM agents sometimes wrap the command in matching quotes, e.g.
 *   "ls -la"   or   'ls -la'
 * These are not needed (the command is already a raw string at this point) and
 * cause shell parse errors when we embed the command in our wrapper.  We only
 * strip when the **entire** string is wrapped in a single pair of matching
 * quotes and the interior is balanced (i.e. the quote char does not appear
 * unescaped inside).
 */
function stripOuterQuotes(cmd: string): string {
  // Need at least 3 chars for a quoted non-empty command: quote + char + quote
  if (cmd.length < 3) return cmd;
  const first = cmd[0];
  const last = cmd[cmd.length - 1];

  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    const inner = cmd.slice(1, -1);
    // Only strip if the quote character does not appear unescaped inside.
    // For double quotes: no unescaped " (allow \")
    // For single quotes: no ' at all (single quotes cannot be escaped inside single quotes)
    if (first === '"') {
      // Check for unescaped double quotes inside
      if (!/(?<!\\)"/.test(inner)) {
        return inner;
      }
    } else {
      // Single quotes: no escaping possible, so no ' allowed inside
      if (!inner.includes("'")) {
        return inner;
      }
    }
  }

  return cmd;
}

/**
 * Build the full line sent via `send-keys` for a tracked command. Wraps the
 * user's command in `sh -c '...'` so parsing is POSIX regardless of the pane's
 * interactive shell (zsh/fish/bash/…). When a timeout is requested, detects
 * `gtimeout`/`timeout` inline (on the target host, at invocation time — no
 * cache), wrapping the command when a binary is found, and running unguarded
 * when not (the outer poll loop handles the Ctrl-C fallback).
 *
 * `suppressHistory` (default **true**) prepends a single space, which keeps
 * the line out of history for shells configured with HISTCONTROL=ignorespace /
 * HIST_IGNORE_SPACE (bash/zsh); a no-op elsewhere. Set to `false` explicitly
 * to allow the wrapped command to appear in shell history.
 */
function buildWrappedCommand(
  command: CommandExecution,
  userCmd: string,
  timeoutSeconds?: number,
  suppressHistory?: boolean,
  displayLabel?: string,
): string {
  const idShort = command.id.slice(0, 8);

  // Marker emit lines use string-concatenation in the source ("TMUX""_MCP_…")
  // so the contiguous marker only appears in the *output*, never in the
  // wrapper source itself. This matters because:
  //   1. tmux echoes the typed command line back through the pty before
  //      running it, and
  //   2. `sh` reprints the offending source on a parse error.
  // Without this trick the parser's lastIndexOf would latch onto those echoes
  // and either match a bogus end-marker (no exit code) or — worse — mark the
  // command done when it never actually ran.
  const startEcho = `echo "TMUX""_MCP_START_${idShort}"`;
  const endEcho = `echo "TMUX""_MCP_DONE_${idShort}_$?"`;

  // Human-readable label so the user can see what command is running.
  // When displayLabel is provided, use it instead of the raw command — useful
  // for tools sending large inline payloads (file-upload, file-download) that
  // would otherwise dump the entire payload into the banner.
  const labelText = `# Running: ${displayLabel ?? userCmd}`;
  const separator = '#'.repeat(Math.min(labelText.length, 80));

  // Always assign userCmd to a shell variable using a single-quoted literal
  // and run it via an inner `sh -c "$U"`. This isolates user-side parse errors
  // from the wrapper: if `$U` fails to parse, the inner sh reports the error
  // and exits non-zero, but the outer sh keeps running and still emits the end
  // marker. Inline embedding would take the whole wrapper down at parse time,
  // leaving the poller blocked forever.
  // `'` inside userCmd is escaped as `'\''`.
  const userCmdSQ = "'" + userCmd.replace(/'/g, "'\\''") + "'";

  let body: string;
  if (timeoutSeconds === undefined) {
    body =
      `echo ${shellSingleQuote(separator)}; ` +
      `echo ${shellSingleQuote(labelText)}; ` +
      `echo ${shellSingleQuote(separator)}; ` +
      `U=${userCmdSQ}; ` +
      `${startEcho}; ` +
      `sh -c "$U"; ` +
      `${endEcho}`;
  } else {
    // Detect timeout command first, then print the label including which
    // timeout mechanism will be used, so the user sees it before the command runs.
    body =
      `T=$(command -v gtimeout 2>/dev/null || command -v timeout 2>/dev/null); ` +
      `echo ${shellSingleQuote(separator)}; ` +
      `echo ${shellSingleQuote(labelText)}; ` +
      `if [ -n "$T" ]; then echo "# (timeout: ${timeoutSeconds}s via $T)"; else echo "# (timeout: ${timeoutSeconds}s via Ctrl-C)"; fi; ` +
      `echo ${shellSingleQuote(separator)}; ` +
      `U=${userCmdSQ}; ` +
      `${startEcho}; ` +
      `\${T:+$T ${timeoutSeconds}s} sh -c "$U"; ` +
      `${endEcho}`;
  }

  const line = `sh -c ${shellSingleQuote(body)}`;
  // Default to prepending a space (suppressHistory) — our wrapped commands are
  // bookkeeping noise that should not pollute the user's shell history.
  const suppress = suppressHistory !== false;  // default true; only skip when explicitly false
  return suppress ? ` ${line}` : line;
}

export type BlockingStatus =
  | 'completed'
  | 'error'
  | 'timed_out'
  | 'timed_out_interrupted'
  | 'timed_out_still_running';

export interface BlockingResult {
  commandId: string;
  status: BlockingStatus;
  exitCode: number | null;
  output: string;
}

export interface RunBlockingOptions {
  timeoutSeconds?: number;        // undefined = wait indefinitely
  pollIntervalMs?: number;        // default 500
  interruptOnTimeout?: boolean;   // default true
  interruptCount?: number;        // default 3
  interruptIntervalMs?: number;   // default 200
  postInterruptWaitMs?: number;   // default 500
  suppressHistory?: boolean;      // prepend space to dodge history (bash/zsh w/ ignorespace)
  displayLabel?: string;          // override the "# Running: ..." banner text
}

export interface WaitForPaneContentOptions {
  regex?: boolean;
  timeoutSeconds: number;
  pollIntervalMs?: number;
  lines?: number;
  ignoreExisting?: boolean;
}

/**
 * Submit a command with marker wrapping, then block until completion or timeout.
 *
 * Timeout handling is always inline: when `timeoutSeconds` is set, the wrapper
 * probes for `gtimeout`/`timeout` on the target host (which may be remote over
 * SSH, a container, etc.) at invocation time. When found, exit code 124/137
 * signals the timeout fired. When not found, the wrapper runs the command
 * unguarded and we fall back to the manual Ctrl-C path once the poll deadline
 * hits; kill success is verified by comparing pane_current_command before/after.
 */
export async function runBlocking(
  paneId: string,
  command: string,
  opts: RunBlockingOptions = {}
): Promise<BlockingResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? 500;
  const interruptOnTimeout = opts.interruptOnTimeout ?? true;
  const interruptCount = opts.interruptCount ?? 3;
  const interruptIntervalMs = opts.interruptIntervalMs ?? 200;
  const postInterruptWaitMs = opts.postInterruptWaitMs ?? 500;

  const wantsTimeout = opts.timeoutSeconds !== undefined;

  // Foreground snapshot for verifying a successful Ctrl-C kill later.
  const foregroundBefore = wantsTimeout ? await getPaneCurrentCommand(paneId) : null;

  const commandId = await executeCommand(paneId, command, {
    timeoutSeconds: opts.timeoutSeconds,
    suppressHistory: opts.suppressHistory,
    displayLabel: opts.displayLabel,
  });

  // Polling deadline. When a timeout was requested, give a generous +10s
  // safety net: the inline `timeout` binary (if present on the target) may
  // take a beat to kill + for the end marker to surface. If no binary is
  // present, the end marker never appears within the window and we hit the
  // deadline, triggering the Ctrl-C fallback below.
  const deadline = wantsTimeout
    ? Date.now() + (opts.timeoutSeconds! + 10) * 1000
    : Number.POSITIVE_INFINITY;

  while (true) {
    const status = await checkCommandStatus(commandId);
    if (status && status.status !== 'pending') {
      const exitCode = status.exitCode ?? null;
      // 124 = SIGTERM from `timeout`; 137 = SIGKILL (via --kill-after, not
      // currently used but covered for safety).
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

    if (Date.now() >= deadline) break;

    const remaining = deadline - Date.now();
    await sleep(Math.min(pollIntervalMs, Math.max(remaining, 0)));
  }

  // Deadline hit without seeing the end marker — no `timeout` binary on the
  // target, command still running.
  const partial = await capturePaneContent(paneId, 3000);

  if (!interruptOnTimeout) {
    return { commandId, status: 'timed_out', exitCode: null, output: partial };
  }

  // Manual C-c fallback path
  for (let i = 0; i < interruptCount; i++) {
    await sendInterrupt(paneId);
    if (i < interruptCount - 1) await sleep(interruptIntervalMs);
  }
  await sleep(postInterruptWaitMs);

  const foregroundAfter = await getPaneCurrentCommand(paneId);
  const finalOutput = await capturePaneContent(paneId, 3000);

  const killed = foregroundAfter === foregroundBefore;
  return {
    commandId,
    status: killed ? 'timed_out_interrupted' : 'timed_out_still_running',
    exitCode: null,
    output: finalOutput,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Get all active command IDs
export function getActiveCommandIds(): string[] {
  return Array.from(activeCommands.keys());
}

// Clean up completed commands older than a certain time
export function cleanupOldCommands(maxAgeMinutes: number = 60): void {
  const now = new Date();

  for (const [id, command] of activeCommands.entries()) {
    const ageMinutes = (now.getTime() - command.startTime.getTime()) / (1000 * 60);

    if (command.status !== 'pending' && ageMinutes > maxAgeMinutes) {
      activeCommands.delete(id);
    }
  }
}

function getStartMarkerText(command: CommandExecution): string {
  return `${startMarkerText}_${command.id.slice(0, 8)}`;
}

function getEndMarkerPrefix(command: CommandExecution): string {
  return `${endMarkerPrefix}${command.id.slice(0, 8)}_`;
}

function getEndMarkerText(command: CommandExecution): string {
  // Always `$?`: the command runs inside `sh -c`, not the pane's interactive shell.
  return `${getEndMarkerPrefix(command)}$?`;
}

// --- OSC 133 Capture Tools ---

type CaptureMode = 'output' | 'command';

/**
 * Capture content using OSC 133 prompt marks via tmux copy mode navigation.
 *
 * Uses tmux's `previous-prompt`, `next-prompt`, and their `-o` (output) variants
 * to select regions delimited by shell-emitted semantic marks.
 *
 * Note: Briefly uses tmux's default paste buffer for the copy operation.
 */
async function captureWithOSC133(paneId: string, n: number, mode: CaptureMode): Promise<string> {
  try {
    // Cancel any leftover copy mode from a previous call
    try {
      await executeTmux(['send-keys', '-X', '-t', paneId, 'cancel']);
    } catch {
      // not in copy mode, that's fine
    }

    // Enter copy mode
    await executeTmux(['copy-mode', '-t', paneId]);

    // Record cursor position to detect whether marks exist
    const initialPos = await executeTmux(
      ['display-message', '-p', '-t', paneId, '#{copy_cursor_x},#{copy_cursor_y}']
    );

    // Navigate to the start of the selection
    const startCmd = mode === 'output' ? 'previous-prompt' : 'previous-prompt';
    const startArgs = mode === 'output'
      ? ['send-keys', '-X', '-t', paneId, startCmd, '-o']
      : ['send-keys', '-X', '-t', paneId, startCmd];
    for (let i = 0; i < n; i++) {
      await executeTmux(startArgs);
    }

    // Verify cursor moved — if not, there are no OSC 133 marks
    const afterNavPos = await executeTmux(
      ['display-message', '-p', '-t', paneId, '#{copy_cursor_x},#{copy_cursor_y}']
    );
    if (initialPos === afterNavPos) {
      await executeTmux(['send-keys', '-X', '-t', paneId, 'cancel']);
      throw new Error(
        `No OSC 133 prompt marks found in pane ${paneId}. ` +
        `Cursor stayed at ${initialPos} after ${startCmd}. ` +
        'Ensure your shell has OSC 133 / Shell Integration enabled.'
      );
    }

    // Begin selection
    await executeTmux(['send-keys', '-X', '-t', paneId, 'begin-selection']);

    // Navigate to the end of the selection
    const endArgs = mode === 'command'
      ? ['send-keys', '-X', '-t', paneId, 'next-prompt', '-o']
      : ['send-keys', '-X', '-t', paneId, 'next-prompt'];
    await executeTmux(endArgs);

    // Adjust selection: next-prompt/next-prompt -o lands ON the mark character,
    // which gets included in the selection. Step back one character to exclude it.
    await executeTmux(['send-keys', '-X', '-t', paneId, 'cursor-left']);

    // Copy selection and exit copy mode (uses default paste buffer)
    await executeTmux(['send-keys', '-X', '-t', paneId, 'copy-selection-and-cancel']);

    // Read the captured content
    const result = await executeTmux(['show-buffer']);
    return result;
  } catch (error: any) {
    // Best-effort exit from copy mode on failure
    try {
      await executeTmux(['send-keys', '-X', '-t', paneId, 'cancel']);
    } catch {
      // ignore cleanup errors
    }

    if (error.message.includes('No OSC 133')) {
      throw error;
    }
    throw new Error(`Failed to capture ${mode}: ${error.message}`);
  }
}

/**
 * Capture the output (stdout/stderr) of the Nth-most-recent command using OSC 133 marks.
 */
export async function captureLastOutput(paneId: string, n: number = 1): Promise<string> {
  return captureWithOSC133(paneId, n, 'output');
}

/**
 * Capture the command line (prompt + typed command) of the Nth-most-recent command.
 * Includes the PS1 prompt prefix since tmux doesn't expose the B mark for navigation.
 *
 * Uses a different strategy than output: navigates to the
 * output start (C mark) via `previous-prompt -o`, then moves up one line to the
 * command line and selects the full line. This is necessary because `next-prompt -o`
 * from an A mark position does not advance to the C mark of the same command —
 * tmux treats them as the same prompt region.
 *
 * Note: Only captures single-line commands. Multi-line commands will only get the last line.
 */
export async function captureLastCommand(paneId: string, n: number = 1): Promise<string> {
  try {
    // Cancel any leftover copy mode from a previous call
    try {
      await executeTmux(['send-keys', '-X', '-t', paneId, 'cancel']);
    } catch {
      // not in copy mode, that's fine
    }

    await executeTmux(['copy-mode', '-t', paneId]);

    const initialPos = await executeTmux(
      ['display-message', '-p', '-t', paneId, '#{copy_cursor_x},#{copy_cursor_y}']
    );

    // Navigate to the output start (C mark) of the Nth command
    for (let i = 0; i < n; i++) {
      await executeTmux(['send-keys', '-X', '-t', paneId, 'previous-prompt', '-o']);
    }

    const afterNavPos = await executeTmux(
      ['display-message', '-p', '-t', paneId, '#{copy_cursor_x},#{copy_cursor_y}']
    );
    if (initialPos === afterNavPos) {
      await executeTmux(['send-keys', '-X', '-t', paneId, 'cancel']);
      throw new Error(
        `No OSC 133 prompt marks found in pane ${paneId}. ` +
        `Cursor stayed at ${initialPos} after previous-prompt -o. ` +
        'Ensure your shell has OSC 133 / Shell Integration enabled.'
      );
    }

    // Move up one line from the output start to the command line
    await executeTmux(['send-keys', '-X', '-t', paneId, 'cursor-up']);

    // Select the full line and copy
    await executeTmux(['send-keys', '-X', '-t', paneId, 'select-line']);
    await executeTmux(['send-keys', '-X', '-t', paneId, 'copy-selection-and-cancel']);

    const result = await executeTmux(['show-buffer']);
    return result;
  } catch (error: any) {
    try {
      await executeTmux(['send-keys', '-X', '-t', paneId, 'cancel']);
    } catch {
      // ignore cleanup errors
    }
    if (error.message.includes('No OSC 133')) {
      throw error;
    }
    throw new Error(`Failed to capture command: ${error.message}`);
  }
}

export interface FileUploadOptions {
  paneId: string;
  destinationPath: string;
  sourcePath?: string;
  content?: string;
  permissions?: string;
  suppressHistory?: boolean;
}

export interface FileTransferResult {
  status: 'completed' | 'error';
  message: string;
  bytesTransferred: number;
}

export async function uploadFile(opts: FileUploadOptions): Promise<FileTransferResult> {
  if (!opts.sourcePath && opts.content === undefined) {
    throw new Error('Either sourcePath or content must be provided');
  }
  if (opts.sourcePath && opts.content !== undefined) {
    throw new Error('Provide either sourcePath or content, not both');
  }

  let rawBuffer: Buffer;
  if (opts.sourcePath) {
    rawBuffer = await readFile(opts.sourcePath);
  } else {
    rawBuffer = Buffer.from(opts.content!, 'utf-8');
  }

  const originalSize = rawBuffer.length;
  const compressed = gzipSync(rawBuffer, { level: 9 });
  const base64 = compressed.toString('base64');

  if (base64.length > MAX_BASE64_PAYLOAD) {
    const maxApprox = Math.round(MAX_BASE64_PAYLOAD * 0.75 / 1024);
    throw new Error(
      `File too large: compressed payload is ${base64.length} chars ` +
      `(limit: ${MAX_BASE64_PAYLOAD}). Original size: ${originalSize} bytes. ` +
      `Use scp/rsync for files larger than ~${maxApprox}KB compressed.`
    );
  }

  const destSQ = shellSingleQuote(opts.destinationPath);
  // Detect base64 decode flag: GNU uses -d, macOS uses -D.
  // Probe by decoding a known value and checking the result.
  let cmd = `B=$(if printf '%s' 'dGVzdA==' | base64 -d 2>/dev/null | grep -q test; then echo d; else echo D; fi); ` +
    `printf '%s' '${base64}' | base64 -$B | gzip -d > ${destSQ}`;
  if (opts.permissions) {
    if (!/^[0-7]{3,4}$/.test(opts.permissions)) {
      throw new Error(`Invalid permissions: ${opts.permissions}. Use octal format (e.g. "644", "0755").`);
    }
    cmd += ` && chmod ${opts.permissions} ${destSQ}`;
  }

  const result = await runBlocking(opts.paneId, cmd, {
    timeoutSeconds: 30,
    suppressHistory: opts.suppressHistory,
    displayLabel: `file-upload → ${opts.destinationPath} (${originalSize}B raw, ${base64.length}B base64)`,
  });

  if (result.status === 'completed') {
    return {
      status: 'completed',
      message: `Successfully uploaded ${originalSize} bytes to ${opts.destinationPath}`,
      bytesTransferred: originalSize,
    };
  }

  return {
    status: 'error',
    message: `Upload failed (exit ${result.exitCode}): ${result.output}`,
    bytesTransferred: 0,
  };
}

export interface FileDownloadOptions {
  paneId: string;
  sourcePath: string;
  destinationPath?: string;
  suppressHistory?: boolean;
}

export interface FileDownloadResult {
  status: 'completed' | 'error';
  message: string;
  content?: string;
  bytesTransferred: number;
}

export async function downloadFile(opts: FileDownloadOptions): Promise<FileDownloadResult> {
  const srcSQ = shellSingleQuote(opts.sourcePath);
  const cmd = `gzip -c ${srcSQ} | base64`;

  const result = await runBlocking(opts.paneId, cmd, {
    timeoutSeconds: 30,
    suppressHistory: opts.suppressHistory,
    displayLabel: `file-download ← ${opts.sourcePath}`,
  });

  if (result.status !== 'completed' || result.exitCode !== 0) {
    return {
      status: 'error',
      message: `Download failed (exit ${result.exitCode}): ${result.output}`,
      bytesTransferred: 0,
    };
  }

  const base64 = result.output.trim().replace(/\s+/g, '');

  if (base64.length > MAX_BASE64_PAYLOAD) {
    return {
      status: 'error',
      message: `Remote file too large: compressed payload is ${base64.length} chars (limit: ${MAX_BASE64_PAYLOAD}). Use scp/rsync instead.`,
      bytesTransferred: 0,
    };
  }

  const compressed = Buffer.from(base64, 'base64');
  let rawBuffer: Buffer;
  try {
    rawBuffer = gunzipSync(compressed);
  } catch (err: any) {
    return {
      status: 'error',
      message: `Failed to decompress downloaded data: ${err.message}`,
      bytesTransferred: 0,
    };
  }
  const bytesTransferred = rawBuffer.length;

  if (opts.destinationPath) {
    await writeFile(opts.destinationPath, rawBuffer);
    return {
      status: 'completed',
      message: `Successfully downloaded ${bytesTransferred} bytes to ${opts.destinationPath}`,
      bytesTransferred,
    };
  }

  return {
    status: 'completed',
    message: `Successfully downloaded ${bytesTransferred} bytes`,
    content: rawBuffer.toString('utf-8'),
    bytesTransferred,
  };
}

/**
 * Shared polling helper for waitForPaneContent and waitForPaneContentGone.
 * Polls pane content until the pattern appears ('appear' mode) or disappears
 * ('disappear' mode).
 */
async function pollPaneContent(
  paneId: string,
  pattern: string,
  options: WaitForPaneContentOptions,
  mode: 'appear' | 'disappear'
): Promise<{ matched: boolean; matchedLine?: string }> {
  const pollInterval = options.pollIntervalMs ?? 500;
  const deadline = Date.now() + options.timeoutSeconds * 1000;

  let matcher: RegExp | null = null;
  if (options.regex) {
    try {
      matcher = new RegExp(pattern);
    } catch (e: any) {
      throw new Error(`Invalid regex pattern "${pattern}": ${e.message}`);
    }
  }

  // When ignoreExisting is true (the default), capture a baseline snapshot
  // and only match against lines that were NOT present in this snapshot.
  let baselineLines: Set<string> | null = null;
  if (options.ignoreExisting !== false) {
    const baselineContent = await capturePaneContent(paneId, options.lines ?? 200);
    baselineLines = new Set(baselineContent.split('\n'));
  }

  while (Date.now() < deadline) {
    const content = await capturePaneContent(paneId, options.lines ?? 200);
    const allLines = content.split('\n');

    // When we have a baseline, only consider lines not in the baseline.
    // We track which baseline lines have been "consumed" so that if the
    // same text appears again (new occurrence), it IS considered new.
    let linesToCheck: string[];
    if (baselineLines !== null) {
      const remainingBaseline = new Map<string, number>();
      for (const bl of baselineLines) {
        remainingBaseline.set(bl, (remainingBaseline.get(bl) ?? 0) + 1);
      }
      linesToCheck = [];
      for (const line of allLines) {
        const count = remainingBaseline.get(line);
        if (count !== undefined && count > 0) {
          // This line existed in the baseline; consume one occurrence
          remainingBaseline.set(line, count - 1);
        } else {
          // This line is new (not in baseline, or extra occurrence)
          linesToCheck.push(line);
        }
      }
    } else {
      linesToCheck = allLines;
    }

    let foundLine: string | undefined;
    for (const line of linesToCheck) {
      if (matcher ? matcher.test(line) : line.includes(pattern)) {
        foundLine = line;
        break;
      }
    }

    if (mode === 'appear' && foundLine !== undefined) {
      return { matched: true, matchedLine: foundLine };
    }
    if (mode === 'disappear' && foundLine === undefined) {
      return { matched: true };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.max(Math.min(pollInterval, remaining), 0));
  }

  return { matched: false };
}

/**
 * Poll pane content until a text or regex pattern appears.
 * Returns `{ found: true, matchedLine }` on success, or `{ found: false }` on timeout.
 */
export async function waitForPaneContent(
  paneId: string,
  pattern: string,
  options: WaitForPaneContentOptions
): Promise<{ found: true; matchedLine: string } | { found: false }> {
  const result = await pollPaneContent(paneId, pattern, options, 'appear');
  if (result.matched) {
    return { found: true, matchedLine: result.matchedLine! };
  }
  return { found: false };
}

/**
 * Poll pane content until a text or regex pattern disappears.
 * Returns `{ gone: true }` when the pattern is no longer found, or `{ gone: false }` on timeout.
 */
export async function waitForPaneContentGone(
  paneId: string,
  pattern: string,
  options: WaitForPaneContentOptions
): Promise<{ gone: true } | { gone: false }> {
  const result = await pollPaneContent(paneId, pattern, options, 'disappear');
  if (result.matched) {
    return { gone: true };
  }
  return { gone: false };
}

