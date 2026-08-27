#!/usr/bin/env bash
# beforeReadFile / preToolUse Read — blocks access to .env files.
set -uo pipefail

PAYLOAD=$(cat)
FILE="${CLAUDE_TOOL_INPUT_FILE_PATH:-}"
if [ -z "$FILE" ]; then
  FILE=$(printf '%s' "$PAYLOAD" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 \
    | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')
fi
if [ -z "$FILE" ]; then
  FILE=$(printf '%s' "$PAYLOAD" | grep -o '"path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 \
    | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')
fi
[ -z "$FILE" ] && exit 0

if echo "$FILE" | grep -qE '(^|[/\\])\.env([^a-zA-Z/\\]|$)'; then
  echo "BLOCKED: .env file access via Read tool" >&2
  exit 2
fi

exit 0
