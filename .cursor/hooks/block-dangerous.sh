#!/usr/bin/env bash
# beforeShellExecution / preToolUse Shell — blocks destructive commands.
# Cursor delivers the command in stdin JSON (`command`); Claude Code used an env var.
set -uo pipefail

PAYLOAD=$(cat)
CMD="${CLAUDE_TOOL_INPUT_COMMAND:-}"
if [ -z "$CMD" ]; then
  CMD=$(printf '%s' "$PAYLOAD" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 \
    | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')
fi

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

if echo "$CMD" | grep -qE '\.env[^a-zA-Z]|\.env$'; then
  echo "BLOCKED: .env file access" >&2
  exit 2
fi

exit 0
