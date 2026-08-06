#!/usr/bin/env bash
# PreToolUse hook for Read — blocks access to .env files.
# block-dangerous.sh only intercepts Bash; this closes the Read-tool gap.
FILE="${CLAUDE_TOOL_INPUT_FILE_PATH:-}"
[ -z "$FILE" ] && exit 0

if echo "$FILE" | grep -qE '(^|[/\\])\.env([^a-zA-Z/\\]|$)'; then
  echo "BLOCKED: .env file access via Read tool" >&2
  exit 2
fi

exit 0
