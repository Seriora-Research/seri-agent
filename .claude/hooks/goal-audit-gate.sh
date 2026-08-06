#!/usr/bin/env bash
# probe
# PreToolUse hook for Skill — blocks dispatch of the mode planner skill
# (feature-plan / bugfix-report / research-spec) until STATE.md has a
# `## Goal Audit` block with a non-empty success_check line.
#
# Claude Code delivers hook input as a JSON object on stdin (not env vars):
#   {"hook_event_name":"PreToolUse","tool_name":"Skill","tool_input":{"skill":"...","args":"..."}}
# No jq dependency here — the skill name is a plain identifier, so a
# single-field regex extraction is sufficient and keeps this runner-portable.
set -uo pipefail

PAYLOAD=$(cat)
SKILL=$(echo "$PAYLOAD" | grep -o '"skill"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 \
  | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')

case "$SKILL" in
  feature-plan|bugfix-report|research-spec) ;;
  *) exit 0 ;;
esac

STATE=$(find .claude/loops -name "STATE.md" 2>/dev/null | head -1)
if [ -z "$STATE" ]; then
  echo "BLOCKED: no active STATE.md — run the engineering-loop Goal Audit step first" >&2
  exit 2
fi

if ! grep -q "^## Goal Audit" "$STATE" 2>/dev/null; then
  echo "BLOCKED: STATE.md has no '## Goal Audit' block — invoke challenge-the-goal before planning" >&2
  exit 2
fi

SUCCESS_CHECK=$(grep -m1 "^- success_check:" "$STATE" 2>/dev/null \
  | sed 's/^- success_check:[[:space:]]*//')
if [ -z "$SUCCESS_CHECK" ]; then
  echo "BLOCKED: Goal Audit success_check is empty — restate a verifiable success check before planning" >&2
  exit 2
fi

exit 0
