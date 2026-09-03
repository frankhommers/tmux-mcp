#!/bin/sh
# Assign hook: only notify; the human answers with `tmux-mcp grant`.
#
#   --assign-hook /path/to/notify-only.sh
#
# Works headless and over SSH. Prints nothing, so the request stays pending
# until an answer arrives through the CLI.
set -eu

request=$(cat)
reason=${TMUX_MCP_REASON:-$(printf '%s' "$request" | sed -n 's/.*"reason": "\(.*\)",/\1/p')}
# The dispatch url when the dispatch service runs, otherwise the grant command.
body=${TMUX_MCP_DISPATCH_URL:-"tmux-mcp grant ${TMUX_MCP_REQUEST_ID:-<id>} <target>"}

if command -v terminal-notifier >/dev/null 2>&1; then
  terminal-notifier -title 'tmux-mcp' -subtitle "$reason" -message "$body" >/dev/null 2>&1 || true
elif command -v notify-send >/dev/null 2>&1; then
  notify-send 'tmux-mcp' "$reason
$body" >/dev/null 2>&1 || true
fi

exit 0
