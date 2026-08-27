# Loop State — tui-per-call-commit
- Mode: feature
- Task: issue #182 — TUI commits tool-call/result lines per-call (real-time), not at turn end. Successor to spec 034 / issue 173 / PR 181.
- Branch: feat/tui-per-call-commit
- Status: PLAN
- Started: 2026-08-27T02:58:00Z  |  Updated: 2026-08-27T03:06:12Z

## Model config
| role              | model   |
|-------------------|---------|
| orchestrator      | inherit |
| env-detector      | inherit |
| explorer          | inherit |
| researcher        | inherit |
| planner           | inherit |
| implementer       | inherit |
| reviewer-verifier | inherit |
| test-runner       | inherit |

## Goal Audit
- triggers_fired: [T3]
- tier: 3
- resolution: DECISION: Lionel confirmed per-call over spec 034 turn-end (War Room 2026-08-26). Keep 034 visual language (muted compact lines, trimPath, TREE_BRANCH, write_file/edit box, plain CLI untouched). Reverse only the commit point.
- confirmed_goal: The TUI commits each tool-call/result as a compact muted transcript line immediately when that call settles (tool-result or permission-denied), so the user can see what the agent is doing in real time. The live pending line remains for the in-flight call. write_file/edit approval box and plain CLI are unchanged.
- success_check: A turn of two sequential tools produces two muted transcript entries BEFORE the done/Cooked-for marker, each appearing when that call's tool-result is applied (reducer: after tool-result and before done, transcript already contains the muted line). Not a single flush at turn end.

## Plan checklist
- [ ] Rewrite reducer tests RED for per-call (assert muted line on tool-result before done; two calls → two lines; no aggregate).
- [ ] Change `tool-result` / `permission-denied` in `applyLoopEvent` to immediate muted `pushLine`; keep `recordCall` + leftover flush on `done`/`turn-ended`; `error` non-flush.
- [ ] Simplify `toolActivity.ts`: no name-aggregation; count===1 render only; keep helpers.
- [ ] Update `docs/design/tui.md`.
- [ ] Fix remaining unit tests (`toolActivity.test.ts`, App comments).
- [ ] Run lint, typecheck, full `apps/cli` test; record exit codes.

## Gate results (latest)
| gate      | command | exit | notes |
|-----------|---------|------|-------|
| lint      |         |      |       |
| typecheck |         |      |       |
| tests     |         |      |       |

## Manual test
- verdict: SKIPPED
- machine: user's computer
- flows_run: 0
- evidence:
- failures: none

## Reviewer verdict

## Open questions / blockers
-
