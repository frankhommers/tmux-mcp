#!/bin/sh
# Assign hook: ask in a macOS dialog, so you do not have to be looking at tmux.
#
#   --assign-hook /path/to/macos-dialog.sh
#
# Requires a GUI session (does not work over plain SSH), but no Automation or
# Accessibility permission: the dialog belongs to osascript itself, which is
# brought to the front with `activate`. It gives up after 30 minutes — the
# same moment the request expires. Giving up prints nothing, which leaves the
# request open for `tmux-mcp grant`.
set -eu

request=$(cat)
reason=${TMUX_MCP_REASON:-$(printf '%s' "$request" | sed -n 's/.*"reason": "\(.*\)",/\1/p')}
kind=${TMUX_MCP_KIND:-pane}
# Labels are a snapshot from when the agent asked; any existing id is accepted.
# A busy tmux server has dozens of panes, which turns the dialog into a wall
# of text, so only the first few are shown as a hint.
MAX_SHOWN=10
all_labels=$(printf '%s' "$request" | sed -n 's/^ *"label": "\(.*\)"$/\1/p' | tr -d '\\')
total=$(printf '%s\n' "$all_labels" | grep -c . || true)
candidates=$(printf '%s\n' "$all_labels" | head -n "$MAX_SHOWN")
if [ "$total" -gt "$MAX_SHOWN" ]; then
  candidates="$candidates
  … and $((total - MAX_SHOWN)) more (run: tmux-mcp requests)"
fi

message="An agent requests a tmux $kind.

Reason: $reason

Open when the agent asked:
$candidates

Type the id of the $kind it may use. A $kind you open right now is fine too —
the list above is only a hint."

script=$(mktemp -t tmux-mcp-dialog)
trap 'rm -f "$script"' EXIT

cat > "$script" <<'APPLESCRIPT'
on run argv
  set msg to item 1 of argv
  tell me to activate
  set reply to display dialog msg default answer "" with title "tmux-mcp" buttons {"Deny", "Assign"} default button "Assign" giving up after 1800
  if gave up of reply then
    return ""
  else if button returned of reply is "Deny" then
    return "deny"
  else
    return text returned of reply
  end if
end run
APPLESCRIPT

# The message is passed as an argument, never interpolated into the script, so
# a pane title containing quotes or $ cannot break the AppleScript.
answer=$(osascript "$script" "$message" 2>/dev/null) || exit 0
printf '%s' "$answer"
