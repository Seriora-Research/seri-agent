#!/usr/bin/env bash
# PreToolUse hook for Bash — blocks destructive commands.
# $CLAUDE_TOOL_INPUT_COMMAND is set by Claude Code to the command string.
set -uo pipefail

CMD="${CLAUDE_TOOL_INPUT_COMMAND:-}"

# Patterns that are always blocked
BLOCKED=(
  "rm -rf /"
  "rm -rf ~"
  "rm -rf \*"
  "git push --force.*main"
  "git push --force.*master"
  "git push -f.*main"
  "git push -f.*master"
  "git reset --hard"
  "chmod -R 777"
  "dd if="
  "mkfs"
  ":(){ :|:& };:"
)

for pattern in "${BLOCKED[@]}"; do
  if echo "$CMD" | grep -qE "$pattern"; then
    echo "BLOCKED: dangerous command pattern detected: $pattern" >&2
    exit 2
  fi
done

# Block .env access
if echo "$CMD" | grep -qE '\.env[^a-zA-Z]|\.env$'; then
  echo "BLOCKED: .env file access" >&2
  exit 2
fi

exit 0
