#!/usr/bin/env bash
# Stop hook — exit 2 blocks Stop and forces Claude to keep working.
# Guards against: firing outside EXECUTE/VERIFY, research mode, infinite retry.
set -uo pipefail

# --- Guard: only run when an engineering-loop EXECUTE/VERIFY phase is active ---
STATE=$(find .claude/loops -name "STATE.md" 2>/dev/null | head -1)
if [ -z "$STATE" ]; then exit 0; fi

MODE=$(grep -m1 "^- Mode:" "$STATE" 2>/dev/null \
  | sed 's/^- Mode:[[:space:]]*//' | tr -d '[:space:]')
STATUS=$(grep -m1 "^- Status:" "$STATE" 2>/dev/null \
  | sed 's/^- Status:[[:space:]]*//' | tr -d '[:space:]')

# Skip research mode — it writes no code so there is nothing to gate.
if [ "$MODE" = "research" ]; then exit 0; fi
# Skip phases where the gate is irrelevant (INIT, EXPLORE, PLAN, DONE, BLOCKED).
if [ "$STATUS" != "EXECUTE" ] && [ "$STATUS" != "VERIFY" ]; then exit 0; fi

# --- Iteration ceiling: stop forcing continuation after N consecutive failures ---
SLUG_DIR=$(dirname "$STATE")
FAIL_COUNT_FILE="$SLUG_DIR/.gate-fail-count"
MAX_CONSECUTIVE_FAILURES=5
FAIL_COUNT=0
if [ -f "$FAIL_COUNT_FILE" ]; then
  raw=$(cat "$FAIL_COUNT_FILE" 2>/dev/null | tr -d '[:space:]')
  FAIL_COUNT=$(( raw + 0 )) 2>/dev/null || FAIL_COUNT=0
fi

# --- Detect package manager from environment.md ---
ENV_FILE=$(find .claude/loops -name "environment.md" 2>/dev/null | head -1)
PKG_MGR="npm"
if [ -n "$ENV_FILE" ]; then
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
