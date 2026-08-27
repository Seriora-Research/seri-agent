# Trajectory — tui-per-call-commit

## 2026-08-27T02:58:00Z INIT
- Mode: feature
- Issue: https://github.com/lzvxck/seri-agent/issues/182
- Branch: feat/tui-per-call-commit
- DECISION: user confirmed per-call over spec 034 turn-end because seeing the agent in real time is safer than a turn-end summary.
- Next: EXPLORE then feature-plan. Promote later into docs/specs/034-tui-tool-transcript/ (successor, do not allocate a new spec ID).

## 2026-08-27T03:06:12Z PLAN
- Wrote `.claude/loops/tui-per-call-commit/feature-plan.md` from the War Room plan; filled real file:line from `feat/tui-per-call-commit` @ 8d9e31b. Architecture unchanged (per-call commit, drop name-aggregation, no new TranscriptEntry variant, leftover-open-call flush on done/turn-ended, error non-flush).
- STATE.md Status → PLAN. Plan checklist filled from the six ordered EXECUTE steps.
- Do not promote to `docs/specs/034-tui-tool-transcript/` until Lionel approves (Handler).
- Next: human approval, then EXECUTE.
