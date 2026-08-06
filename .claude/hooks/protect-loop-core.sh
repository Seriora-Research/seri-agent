#!/usr/bin/env bash
# PreToolUse hook for Write|Edit — freezes the loop's own governing files
# (hooks, settings, agent/skill definitions, templates) while a loop is
# active, so no model — weak, strong, or mid-RETRO self-improvement pass —
# can rewrite the machinery that is supposed to be grading and gating it.
#
# Deliberately NOT frozen: CLAUDE.md, .claude/rules/*.md, .claude/lessons/**,
# .claude/loops/**, and ordinary project source. Those are the intended
# mutable surface — lessons get promoted into CLAUDE.md/rules, never into
# the enforcement layer itself.
set -uo pipefail

PAYLOAD=$(cat)
FILE=$(echo "$PAYLOAD" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 \
  | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')
[ -z "$FILE" ] && exit 0

# Only guard while a loop is actually running.
STATE=$(find .claude/loops -name "STATE.md" 2>/dev/null | head -1)
[ -z "$STATE" ] && exit 0

# JSON escapes each Windows backslash as two characters ("\\"), so tr on a
# single '\' would double every slash instead of collapsing it. Collapse the
# doubled form first, then any stray single backslashes.
NORM=$(printf '%s' "$FILE" | sed -e 's/\\\\/\//g' -e 's/\\/\//g')

case "$NORM" in
  *.claude/hooks/*|*.claude/settings.json|*.claude/agents/*|*.claude/skills/*|*.claude/templates/*)
    echo "BLOCKED: $FILE defines loop enforcement/behavior and cannot be edited while a loop is active ($STATE). Propose changes via the retro subagent into .claude/lessons/proposed/, or edit it outside any active loop." >&2
    exit 2
    ;;
esac

exit 0
