#!/usr/bin/env bash
# PreToolUse hook for Skill — blocks dispatch of the mode planner skill
# (feature-plan / bugfix-report / research-spec) until STATE.md has a
# `## Goal Audit` block with a non-empty success_check line.
#
# Claude Code delivers hook input as a JSON object on stdin (not env vars):
#   {"session_id":"…","hook_event_name":"PreToolUse","tool_name":"Skill","tool_input":{"skill":"…"}}
# No jq dependency here — the fields read are plain identifiers, so single-field
# regex extraction is sufficient and keeps this runner-portable.
#
# CHANGED 2026-08-06: this gate used to read `find .claude/loops -name STATE.md | head -1`,
# which returns whichever path readdir yields first — not the loop this session is running.
# With 14 loop directories on disk it was validating the Goal Audit of a run that finished
# two days earlier, and passing. A gate that reads the wrong file reports green identically
# to one that works.
set -uo pipefail

PAYLOAD=$(cat)

json_str() {
  printf '%s' "$PAYLOAD" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 \
    | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/'
}

SKILL=$(json_str skill)
case "$SKILL" in
  feature-plan|bugfix-report|research-spec) ;;
  *) exit 0 ;;
esac

# --- Resolve THIS session's loop ---
SID=$(json_str session_id)
STATE=""
if [ -n "$SID" ]; then
  for f in .claude/loops/*/SESSION; do
    [ -f "$f" ] || continue
    if [ "$(tr -d '[:space:]' < "$f")" = "$SID" ]; then
      STATE="$(dirname "$f")/STATE.md"
      break
    fi
  done
fi

# Backward compatibility until the orchestrator writes SESSION files. maxdepth 2 excludes
# archived loops under .claude/loops/_archive/<slug>/.
if [ -z "$STATE" ]; then
  COUNT=$(find .claude/loops -maxdepth 2 -name "STATE.md" 2>/dev/null | wc -l)
  if [ "$COUNT" -eq 1 ]; then
    STATE=$(find .claude/loops -maxdepth 2 -name "STATE.md" 2>/dev/null | head -1)
  elif [ "$COUNT" -gt 1 ]; then
    # Ambiguous, and this gate fails CLOSED: guessing could green-light planning against
    # another run's audit block, which is the defect this rewrite exists to remove.
    echo "BLOCKED: $COUNT active loops and no SESSION file identifies this one — write the session id to .claude/loops/<slug>/SESSION at INIT" >&2
    exit 2
  fi
fi

if [ -z "$STATE" ] || [ ! -f "$STATE" ]; then
  echo "BLOCKED: no active STATE.md — run the engineering-loop Goal Audit step first" >&2
  exit 2
fi

if ! grep -q "^## Goal Audit" "$STATE" 2>/dev/null; then
  echo "BLOCKED: $STATE has no '## Goal Audit' block — invoke challenge-the-goal before planning" >&2
  exit 2
fi

SUCCESS_CHECK=$(grep -m1 "^- success_check:" "$STATE" 2>/dev/null \
  | sed 's/^- success_check:[[:space:]]*//')
if [ -z "$SUCCESS_CHECK" ]; then
  echo "BLOCKED: $STATE's Goal Audit success_check is empty — restate a verifiable success check before planning" >&2
  exit 2
fi

exit 0
