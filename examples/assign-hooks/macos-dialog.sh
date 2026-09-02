#!/bin/sh
# Assign hook: ask in a macOS dialog, so the human does not need to be
# looking at tmux.
#
#   --assign-hook /path/to/macos-dialog.sh
#
# Requires a GUI session (does not work over plain SSH).
set -eu

request=$(cat)
reason=${TMUX_MCP_REASON:-$(printf '%s' "$request" | sed -n 's/.*"reason": "\(.*\)",/\1/p')}
candidates=$(printf '%s' "$request" | sed -n 's/^ *"label": "\(.*\)"$/\1/p')

message="An agent requests a tmux pane.

Reason: $reason

$candidates

Type the pane id to assign, or leave empty to decide later:"

target=$(osascript -e "display dialog \"$message\" default answer \"\" with title \"tmux-mcp\"" \
  -e 'text returned of result' 2>/dev/null) || exit 0

printf '%s' "$target"
