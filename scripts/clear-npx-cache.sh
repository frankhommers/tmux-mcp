#!/usr/bin/env bash
#
# Remove cached tmux-mcp packages from the npx cache so the next
# invocation fetches a fresh copy (from npm or GitHub).
#
set -euo pipefail

NPX_CACHE="${HOME}/.npm/_npx"

if [ ! -d "$NPX_CACHE" ]; then
  echo "npx cache directory not found: $NPX_CACHE"
  exit 0
fi

found=0
for dir in "$NPX_CACHE"/*/; do
  if [ -d "${dir}node_modules/tmux-mcp" ] || [ -d "${dir}node_modules/.bin/tmux-mcp" ]; then
    echo "removing: $dir"
    rm -rf "$dir"
    found=$((found + 1))
  fi
done

if [ "$found" -eq 0 ]; then
  echo "No cached tmux-mcp packages found."
else
  echo "Cleared $found cached tmux-mcp package(s)."
fi
