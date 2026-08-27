#!/usr/bin/env bash
# sessionStart — persist this Cursor session id so loop INIT can stamp SESSION.
set -uo pipefail

PAYLOAD=$(cat)
json_str() {
  printf '%s' "$PAYLOAD" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 \
    | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/'
}

SID=$(json_str session_id)
[ -z "$SID" ] && SID=$(json_str conversation_id)
[ -z "$SID" ] && exit 0
printf '%s' "$SID" > .cursor/session-id
exit 0
