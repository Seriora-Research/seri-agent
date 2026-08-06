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
#
# This hook is a GLOBAL freeze, so unlike the other loop-aware hooks it deliberately does
# not resolve "which loop is mine" from session_id — any live loop anywhere freezes these
# files for everyone. What it does need is a truthful liveness signal:
#
#   - `-maxdepth 2` keeps archived runs (.claude/loops/_archive/<slug>/) from counting.
#   - the Status check keeps a finished-but-not-yet-archived run from counting either.
#
# Without the second test a stale STATE.md from a run that ended days ago freezes these
# files indefinitely — which is how this freeze came to block its own repair on 2026-08-06.
# Fails closed: a STATE.md whose Status cannot be read counts as live.
ACTIVE=""
for s in $(find .claude/loops -maxdepth 2 -name "STATE.md" 2>/dev/null); do
  ST=$(grep -m1 "^- Status:" "$s" 2>/dev/null | sed 's/^- Status:[[:space:]]*//' | tr -d '[:space:]')
  case "$ST" in
    DONE*|BLOCKED*) continue ;;
  esac
  ACTIVE="$s"
  break
done
[ -z "$ACTIVE" ] && exit 0

# JSON escapes each Windows backslash as two characters ("\\"), so tr on a
# single '\' would double every slash instead of collapsing it. Collapse the
# doubled form first, then any stray single backslashes.
NORM=$(printf '%s' "$FILE" | sed -e 's/\\\\/\//g' -e 's/\\/\//g')

case "$NORM" in
  *.claude/hooks/*|*.claude/settings.json|*.claude/agents/*|*.claude/skills/*|*.claude/templates/*)
    echo "BLOCKED: $FILE defines loop enforcement/behavior and cannot be edited while a loop is active ($ACTIVE). Propose changes via the retro subagent into .claude/lessons/proposed/, or edit it outside any active loop." >&2
    exit 2
    ;;
esac

exit 0
