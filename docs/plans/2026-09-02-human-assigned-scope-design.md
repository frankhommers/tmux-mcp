# Human-assigned scope (`--human-assigned`)

## Goal

Let a human decide, per request, which tmux panes/windows an agent may touch.
The agent starts with access to nothing. It asks for a pane; the human is
asked (outside the LLM's reach) and picks one; only then does that pane enter
the agent's scope. The agent never sees the full list of panes, only what it
was given.

The agent (and this server) do not need to run inside tmux.

## Non-goals

- Replacing the existing `--scope session|window`. Human-assigned is a
  modifier on top of it (see Scope semantics).
- Protecting against agents that have another route to tmux (e.g. a free
  shell with `tmux send-keys`). The scope is only as strong as the agent's
  other tools. Documented, not solved.
- Building every notification/prompt channel into the server. Anything
  beyond elicitation and the grant CLI goes through the assign hook.

## CLI

```
--human-assigned              # or TMUX_MCP_HUMAN_ASSIGNED=1
--assign-hook <path>          # optional script, see Assign hook (TMUX_MCP_ASSIGN_HOOK)
--requests-dir <path>         # default ~/.tmux-mcp/requests (TMUX_MCP_REQUESTS_DIR)
```

Three channels can answer a request; all race on the same pending record and
the first answer wins:

1. **Elicitation** — used automatically when the connected client advertised
   the `elicitation` capability at `initialize`. Built in, because it runs
   over the MCP transport and cannot be done from a script.
2. **Grant CLI** — always active. A human may pre-grant or grant from any
   shell at any time.
3. **Assign hook** — only when `--assign-hook` is set. The user's own script
   decides how the human is reached (tmux popup, OS dialog, chat message…)
   and may answer directly or just notify.

Subcommands on the same binary (`tmux-mcp <cmd>`), for the grant channel:

```
tmux-mcp requests                 # list pending requests (id, age, reason, pid)
tmux-mcp grant <id> <target>      # target: pane id (%3) or window id (@2)
tmux-mcp deny <id> [reason]
```

## Scope semantics

New module `src/grants.ts` holds:

- `grantedPanes: Set<paneId>`, `grantedWindows: Set<windowId>`
- the pending-request registry (in memory, mirrored to the requests dir)

`scope.ts` gains `isHumanAssigned()` and consults grants inside `isInScope`:

| resource | allowed when |
|---|---|
| pane | id in `grantedPanes`, OR its window in `grantedWindows` |
| window | id in `grantedWindows` |
| session | it contains at least one granted pane/window (so `list-sessions`/`list-windows` can show the path to it) |

Human-assigned **intersects** with the static scope: with `--scope window
--human-assigned` a grant outside that window is refused at grant time
with a clear error to the human, not to the agent.

Derived access:

- Splitting a granted pane (`split-pane`, `new-pane`, `new-pane-smart`)
  auto-grants the new pane. It lives inside what the human gave.
- `new-pane-smart`'s new-window fallback is disabled in human-assigned mode.
- `create-session`, `create-window`, `move-window` are disabled (same as
  window scope). `kill-window` only on granted windows; `kill-pane` only on
  granted panes.
- When a granted pane/window disappears (control-mode watcher reports
  `%window-close`/`%layout-change`, or a tmux command fails with "can't find
  pane"), it is removed from the set.

With no grants the agent sees empty lists and `Access denied` on explicit
ids. Error messages never include ids the agent was not granted.

## Tool: `request-pane`

```
request-pane
  reason: string (required, max ~200 chars, shown to the human verbatim)
  kind: "pane" | "window" (default "pane")
  timeoutSeconds?: number (default 30; capped by the existing client-timeout
                           rules; progressToken lifts the cap as elsewhere)
  requestId?: string  (poll an earlier, still-pending request)
```

Flow:

1. Server builds the candidate list itself: every pane (or window) in the
   static scope, excluding the server's own pane (`$TMUX_PANE`) unless
   `--include-current-pane`, excluding already-granted items. Each entry:
   `%3  main:1.2  zsh  "logs"` (id, session:window.pane, current command,
   title).
2. Creates a request `{ id, reason, kind, candidates, createdAt, pid }`,
   writes `<requests-dir>/<id>.json` (mode 0600, dir 0700).
3. Notifies the human, best effort, all of:
   - `tmux display-message` on every attached client:
     `tmux-mcp: agent requests a pane (<reason>) — run: tmux-mcp grant <id> <target>`
   - MCP `notifications/message` (level `notice`)
   - stderr line
4. Channels (all started together, first answer wins, others are cancelled):
   - **elicitation**: `server.server.elicitInput({ message, requestedSchema })`
     with `target` as an enum of candidate ids (enum labels carry the
     human-readable line) plus `"deny"`. `accept` → grant; `decline`/`cancel`
     → deny.
   - **grant**: watch `<requests-dir>` (fs.watch + 1s poll fallback) for
     `<id>.grant` / `<id>.deny` written by the CLI. A grant file contains the
     target id; the server validates it against the candidate list (so a
     typo or an out-of-scope id is refused and the request stays pending).
   - **hook**: spawn the configured script (see Assign hook). Its stdout, if
     it names a candidate or `deny`, is the answer; otherwise it was a
     notification only.
5. If answered within `timeoutSeconds` the tool returns
   `{ status: "granted", pane: {...} }` (or `{ status: "denied", reason }`).
   Otherwise it returns `{ status: "pending", requestId }`. The request keeps
   living (elicitation stays open, grant files still accepted); the agent
   polls with `request-pane { requestId }` (no separate poll tool).
6. Granted → id added to the grant sets; `.json` removed; a
   `notifications/resources/list_changed` is sent so clients refresh.

Pending requests expire after 30 minutes (file removed, elicitation aborted).
Requests belonging to a dead server (pid gone) are shown as stale by
`tmux-mcp requests` and can be cleaned with `tmux-mcp requests --prune`.

## Assign hook

`--assign-hook <path>` names an executable the server spawns once per new
request. It is the extension point for any way of reaching a human that is
not elicitation.

Input, on stdin, one JSON object:

```json
{
  "id": "r-8f3k2",
  "reason": "run the test suite",
  "kind": "pane",
  "pid": 12345,
  "grantCommand": "tmux-mcp grant r-8f3k2 <target>",
  "candidates": [
    { "id": "%3", "label": "%3  main:1.2  zsh  \"logs\"" },
    { "id": "%5", "label": "%5  main:2.0  node  \"server\"" }
  ]
}
```

Also in env: `TMUX_MCP_REQUEST_ID`, `TMUX_MCP_REASON`, `TMUX_MCP_KIND`,
`TMUX_MCP_REQUESTS_DIR`.

Output contract (stdout, trimmed, first line only):

| stdout | meaning |
|---|---|
| a candidate id (`%3`, `@2`) | grant that target (validated like a grant file) |
| `deny` or `deny: <text>` | deny, optional reason forwarded to the agent |
| empty, exit 0 | notification only; answer arrives via grant CLI or elicitation |
| anything else / exit ≠ 0 | logged at `warning`, ignored; request stays pending |

The hook runs detached from the tool call: it keeps running after
`request-pane` returns `pending`, and is killed when the request is answered
through another channel or expires. Only one hook process per request.

Shipped examples in `examples/assign-hooks/` (documented in the README):

- `tmux-popup.sh` — `tmux display-popup -E` on the most recently active
  client, shows the candidates, reads one line, prints it. Prompt and answer
  in one place for humans who live in tmux.
- `macos-dialog.sh` — `osascript display dialog … default answer`, prints
  the typed target. Works outside tmux, needs a GUI session.
- `notify-only.sh` — `terminal-notifier` / `notify-send` with the grant
  command in the message body, prints nothing. For headless or remote
  setups where the human answers with `tmux-mcp grant`.

## Tool descriptions

In human-assigned mode `list-*` and `new-pane*` descriptions gain one line:
"Access is granted by a human via `request-pane`. Call it with a short reason
when you have no pane yet or need another one." `request-pane` is only
registered when `--human-assigned` is set.

## Security notes

- The elicitation answer travels client → server over the MCP transport; the
  LLM cannot author it.
- The grant channel trusts the requests dir. Anything that can write there
  can grant. Dir is created 0700; the README states the shell-access caveat.
- The candidate list is never returned to the agent. On deny the agent gets
  only the human's optional reason string.

## Open question to settle in the first implementation step

Whether Claude Code aborts the tool request (60s default) while an
elicitation is pending, or pauses the timer. A throwaway one-tool server
answers this in minutes. If it aborts, the pending/poll path above already
covers it; we then default `timeoutSeconds` to a safe value under the cap.

## Testing

- `test/grants.test.mjs`: pure logic — grant/deny, derived access after split,
  intersection with static scope, removal on pane close, candidate list
  excludes self and already-granted.
- `test/grant-cli.test.mjs`: write request file → run `grant` → server picks
  it up; invalid target refused; deny path.
- `test/tool-registration.test.mjs`: `request-pane` registered only with the
  flag; tools disabled as listed.
- `test/assign-hook.test.mjs`: fake hook scripts covering each row of the
  output contract; hook killed when another channel answers first; hook
  failure leaves the request pending.
- Elicitation path: unit test with a fake `elicitInput` (accept / decline /
  cancel / throws).
- Manual: real Claude Code session with `--human-assigned`, both channels.

## Files

- `src/grants.ts` (new), `src/request-pane.ts` (new: candidate list, channels,
  registry), `src/assign-hook.ts` (new: spawn + output contract),
  `src/cli-grant.ts` (new: subcommands), `examples/assign-hooks/*.sh` (new)
- `src/scope.ts` (consult grants), `src/index.ts` (flag parsing, tool,
  descriptions, disable list, subcommand dispatch before server start)
- `README.md` (new section), `docs/plans/…-plan.md` (next step)
