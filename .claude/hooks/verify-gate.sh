#!/usr/bin/env bash
# Stop hook — exit 2 blocks Stop and forces Claude to keep working.
# Guards against: firing outside EXECUTE/VERIFY, research mode, infinite retry.
#
# CHANGED 2026-08-06: this hook used to resolve both STATE.md and environment.md with
# `find .claude/loops -name … | head -1`, which returns whichever path readdir yields
# first — not the loop this session is running. It therefore read another run's Mode and
# Status to decide whether to gate at all, and another run's environment.md to pick the
# package manager (gate commands detected on a different machine, days earlier). Both now
# resolve from this session's own `session_id`, which is a common field on every hook event.
set -uo pipefail

PAYLOAD=$(cat)

json_str() {
  printf '%s' "$PAYLOAD" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 \
    | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/'
}

# --- Resolve THIS session's loop, never "the first one on disk" ---
SID=$(json_str session_id)
LOOP_DIR=""
if [ -n "$SID" ]; then
  for f in .claude/loops/*/SESSION; do
    [ -f "$f" ] || continue
    if [ "$(tr -d '[:space:]' < "$f")" = "$SID" ]; then
      LOOP_DIR=$(dirname "$f")
      break
    fi
  done
fi

# Backward compatibility until every loop writes SESSION. maxdepth 2 excludes archived
# loops under .claude/loops/_archive/<slug>/. On ambiguity this gate exits 0 rather than
# guessing: the failure direction that matters here is forcing a session to keep working
# against another run's state, so it declines to gate instead of gating the wrong loop.
if [ -z "$LOOP_DIR" ]; then
  COUNT=$(find .claude/loops -maxdepth 2 -name "STATE.md" 2>/dev/null | wc -l)
  if [ "$COUNT" -eq 1 ]; then
    LOOP_DIR=$(dirname "$(find .claude/loops -maxdepth 2 -name "STATE.md" 2>/dev/null | head -1)")
  else
    exit 0
  fi
fi

# --- Guard: only run when an engineering-loop EXECUTE/VERIFY phase is active ---
STATE="$LOOP_DIR/STATE.md"
if [ ! -f "$STATE" ]; then exit 0; fi

MODE=$(grep -m1 "^- Mode:" "$STATE" 2>/dev/null \
  | sed 's/^- Mode:[[:space:]]*//' | tr -d '[:space:]')
STATUS=$(grep -m1 "^- Status:" "$STATE" 2>/dev/null \
  | sed 's/^- Status:[[:space:]]*//' | tr -d '[:space:]')

# Skip research mode — it writes no code so there is nothing to gate.
if [ "$MODE" = "research" ]; then exit 0; fi
# Skip phases where the gate is irrelevant (INIT, EXPLORE, PLAN, DONE, BLOCKED).
if [ "$STATUS" != "EXECUTE" ] && [ "$STATUS" != "VERIFY" ]; then exit 0; fi

# --- Iteration ceiling: stop forcing continuation after N consecutive failures ---
FAIL_COUNT_FILE="$LOOP_DIR/.gate-fail-count"
MAX_CONSECUTIVE_FAILURES=5
FAIL_COUNT=0
if [ -f "$FAIL_COUNT_FILE" ]; then
  raw=$(cat "$FAIL_COUNT_FILE" 2>/dev/null | tr -d '[:space:]')
  FAIL_COUNT=$(( raw + 0 )) 2>/dev/null || FAIL_COUNT=0
fi

# --- Detect package manager from THIS loop's environment.md ---
ENV_FILE="$LOOP_DIR/environment.md"
PKG_MGR="npm"
if [ -f "$ENV_FILE" ]; then
  if grep -q "pnpm" "$ENV_FILE" 2>/dev/null; then PKG_MGR="pnpm"; fi
  if grep -q "bun"  "$ENV_FILE" 2>/dev/null; then PKG_MGR="bun";  fi
fi

fail=0
gates_ran=0

# --- JS/TS gates (only when package.json exists) ---
if [ -f package.json ]; then
  gates_ran=1
  if $PKG_MGR run --silent lint 2>/dev/null; then
    echo "LINT passed"
  else
    echo "LINT failed" >&2; fail=1
  fi
  if $PKG_MGR run --silent typecheck 2>/dev/null; then
    echo "TYPECHECK passed"
  else
    echo "TYPECHECK failed" >&2; fail=1
  fi
  if $PKG_MGR test --silent 2>/dev/null; then
    echo "TESTS passed"
  else
    echo "TESTS failed" >&2; fail=1
  fi
fi

# --- Python gate (only when pytest and a project descriptor exist) ---
if command -v pytest &>/dev/null; then
  if [ -f pyproject.toml ] || [ -f setup.py ] || [ -f setup.cfg ]; then
    gates_ran=1
    if pytest -q 2>/dev/null; then
      echo "PYTEST passed"
    else
      echo "PYTEST failed" >&2; fail=1
    fi
  fi
fi

# Nothing to check — not a recognised stack, pass through silently.
if [ "$gates_ran" -eq 0 ]; then
  echo "No recognised test stack found (no package.json / pyproject.toml) — skipping gate" >&2
  exit 0
fi

# --- Result: reset counter on success; increment and enforce ceiling on failure ---
if [ "$fail" -eq 0 ]; then
  rm -f "$FAIL_COUNT_FILE"
  exit 0
fi

FAIL_COUNT=$(( FAIL_COUNT + 1 ))
echo "$FAIL_COUNT" > "$FAIL_COUNT_FILE"

if [ "$FAIL_COUNT" -ge "$MAX_CONSECUTIVE_FAILURES" ]; then
  echo "Gate failed $FAIL_COUNT consecutive times — marking BLOCKED and halting continuation." >&2
  TMP=$(mktemp)
  sed "s/^- Status: .*/- Status: BLOCKED/" "$STATE" > "$TMP" && mv "$TMP" "$STATE"
  rm -f "$FAIL_COUNT_FILE"
  exit 0  # exit 0 stops forcing continuation so the session can end
fi

exit 2
