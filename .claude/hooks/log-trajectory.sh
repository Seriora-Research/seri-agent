#!/usr/bin/env bash
# SubagentStop hook — appends a timestamped entry to the active trajectory.md.
set -uo pipefail

TRAJ=$(find .claude/loops -name "trajectory.md" 2>/dev/null | head -1)
[ -z "$TRAJ" ] && exit 0

AGENT="${CLAUDE_SUBAGENT_NAME:-unknown-agent}"
STATUS="${CLAUDE_SUBAGENT_STATUS:-unknown}"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown-time")

cat >> "$TRAJ" <<EOF

### $TS — subagent: $AGENT
- Status: $STATUS
- Summary: (see subagent return value in main context)
EOF

exit 0
