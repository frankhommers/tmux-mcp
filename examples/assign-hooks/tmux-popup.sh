#!/bin/sh
# Assign hook: ask in a tmux popup on the most recently active client.
#
#   --assign-hook /path/to/tmux-popup.sh
#
# Requires tmux >= 3.2 and an attached client. Prints the chosen target on
# stdout, which assigns it; printing nothing leaves the request pending.
set -eu

request=$(cat)
answer_file=$(mktemp)
trap 'rm -f "$answer_file"' EXIT

reason=${TMUX_MCP_REASON:-$(printf '%s' "$request" | sed -n 's/.*"reason": "\(.*\)",/\1/p')}
candidates=$(printf '%s' "$request" | sed -n 's/^ *"label": "\(.*\)"$/  \1/p')

body=$(printf 'An agent requests a tmux pane.\n\nReason: %s\n\n%s\n' "$reason" "$candidates")

tmux display-popup -E -w 80 -h 20 \
  "printf '%s\n' \"$body\"; printf 'Pane id to assign (empty = decide later): '; \
   read -r target; printf '%s' \"\$target\" > '$answer_file'" </dev/null >/dev/null 2>&1 || exit 0

cat "$answer_file"
