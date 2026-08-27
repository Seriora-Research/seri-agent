#!/usr/bin/env bash
# SubagentStop hook — appends a timestamped entry to the active trajectory.md.
#
# Two bugs fixed here, both measured on 2026-08-06 against
# .cursor/loops/abort-cancellation/trajectory.md — a loop that finished 2026-08-04:
#
#   total entries:              674
#   named "unknown-agent":      671
#   with a real agent name:       3   (written by hand by an orchestrator, not by this hook)
#
# 1. WRONG FILE. `find … -name trajectory.md | head -1` returns whichever path readdir
#    yields first, which has nothing to do with which loop is running. "abort-cancellation"
#    sorted first, so every subagent stop for two days appended there. Fixed by resolving
#    the loop from this session's own `session_id`.
#
# 2. NOTHING TO SAY. The old body read `$CLAUDE_SUBAGENT_NAME` and `$CLAUDE_SUBAGENT_STATUS`.
#    Those environment variables do not exist — Claude Code delivers hook input as JSON on
#    stdin, and this hook never read stdin at all. That is why 671 of 674 rows say
#    "unknown-agent"/"unknown". `.claude/rules/hooks.md` already carries this lesson for
#    block-dangerous, block-env-read and format-and-typecheck; log-trajectory was not on
#    that list and had the same defect. The real fields are `agent_type` and `agent_id`.
#
# Fixing only (1) would have produced 671 rows of noise in the correct file.
#
# 3. STILL 83-89% NOISE POST-FIX (found 2026-08-12, see
#    TRAJECTORY-UNKNOWN-AGENT-LOGGING.md). (2) only repaired named top-level `Agent`
#    dispatches. A dispatched agent's own internal work — nested Task calls, or
#    WebFetch/WebSearch-backed sub-steps it issues itself — fires its own SubagentStop
#    event with `agent_type` genuinely absent from the payload, not mis-parsed. Writing
#    "unknown-agent" for those rows carries zero information beyond a timestamp and an
#    opaque id, and crowded out the named rows that are actually informative (measured
#    83-89% of all subagent: lines across four loops). retro's own trigger table
#    (.claude/agents/retro.md) never keys on these rows — its evidence sources are gate
#    tables, `DECISION:` lines and quoted corrections — so skipping them loses nothing
#    it uses. Fixed by not appending an entry at all when `agent_type` is empty, instead
#    of defaulting to the string "unknown-agent".
set -uo pipefail

PAYLOAD=$(cat)

json_str() {
  printf '%s' "$PAYLOAD" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 \
    | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/'
}

# --- Resolve THIS session's loop, never "the first one on disk" ---
SID=$(json_str session_id)
TRAJ=""
if [ -n "$SID" ]; then
  for f in .cursor/loops/*/SESSION; do
    [ -f "$f" ] || continue
    if [ "$(tr -d '[:space:]' < "$f")" = "$SID" ]; then
      TRAJ="$(dirname "$f")/trajectory.md"
      break
    fi
  done
fi

# Backward compatibility: until the orchestrator writes SESSION files, fall back to the
# single-loop case — but ONLY when it is unambiguous. maxdepth 2 keeps archived loops under
# .cursor/loops/_archive/<slug>/ out of the count. If two loops are live and neither declared
# a session, write nothing: a guess here silently corrupts another run's audit log, which is
# exactly the failure being fixed.
if [ -z "$TRAJ" ]; then
  COUNT=$(find .cursor/loops -maxdepth 2 -name "trajectory.md" 2>/dev/null | wc -l)
  if [ "$COUNT" -eq 1 ]; then
    TRAJ=$(find .cursor/loops -maxdepth 2 -name "trajectory.md" 2>/dev/null | head -1)
  else
    exit 0
  fi
fi

[ -f "$TRAJ" ] || exit 0

AGENT=$(json_str agent_type)
[ -z "$AGENT" ] && AGENT=$(json_str subagent_type)
AGENT_ID=$(json_str agent_id)
[ -z "$AGENT_ID" ] && AGENT_ID=$(json_str subagent_id)
[ -z "$AGENT" ] && exit 0
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown-time")

{
  printf '\n### %s — subagent: %s\n' "$TS" "$AGENT"
  [ -n "$AGENT_ID" ] && printf -- '- Agent id: %s\n' "$AGENT_ID"
  printf -- '- Summary: (see subagent return value in main context)\n'
} >> "$TRAJ"

exit 0
