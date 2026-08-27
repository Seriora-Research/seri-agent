#!/usr/bin/env bash
# PostToolUse hook — auto-format and typecheck the file that was just written/edited.
# $CLAUDE_TOOL_INPUT_FILE_PATH is set by Claude Code to the affected file.
set -uo pipefail

FILE="${CLAUDE_TOOL_INPUT_FILE_PATH:-}"
[ -z "$FILE" ] && exit 0

ext="${FILE##*.}"

case "$ext" in
  ts|tsx|js|jsx|mjs|cjs)
    # Format
    if command -v prettier &>/dev/null; then
      prettier --write "$FILE" --log-level warn
    elif command -v eslint &>/dev/null; then
      eslint --fix "$FILE" 2>/dev/null || true
    fi
    # Typecheck (project-wide — tsc doesn't support single-file check meaningfully)
    if command -v tsc &>/dev/null; then
      tsc --noEmit 2>&1 | head -20 || true
    fi
    ;;
  py)
    if command -v ruff &>/dev/null; then
      ruff format "$FILE"
      ruff check --fix "$FILE" 2>/dev/null || true
    elif command -v black &>/dev/null; then
      black "$FILE" --quiet
    fi
    ;;
  rs)
    if command -v rustfmt &>/dev/null; then
      rustfmt "$FILE"
    fi
    ;;
  go)
    if command -v gofmt &>/dev/null; then
      gofmt -w "$FILE"
    fi
    ;;
esac

exit 0
