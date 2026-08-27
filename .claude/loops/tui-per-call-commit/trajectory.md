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

## 2026-08-27T03:08:37Z PLAN (rewrite)
- DECISION: keep name-aggregation, live in-place update, do not drop Read 2 files. Lionel rejected the prior plan's drop-aggregation architecture.
- Rewrote `feature-plan.md`: live-paint `renderToolActivity(state.toolActivity)` inside the native scrollbox after `TranscriptList` (full `.map()`, not a virtualizer). Reducer still no `pushLine` on tool-result/permission-denied; still flush on done/turn-ended; error non-flush.
- Goal Audit confirmed_goal / success_check updated in STATE.md. Status remains PLAN. Checklist replaced to match the new ordered steps.
- Do not promote to `docs/specs/034-tui-tool-transcript/` until Lionel approves (Handler).
- Next: human approval, then EXECUTE.

## 2026-08-27T03:12:00Z EXECUTE
- DECISION: Lionel auto-approved; Handler owns; keep aggregation.
- Checkout is 6a00eae (keep-aggregation, live-paint). Drop-aggregation draft at 3b43a2f is REJECTED. Do not re-implement it.
- skip: War Room VERIFY opens the PR later.
- Path (closed): live-paint `renderToolActivity` of settled `toolActivity` inside the native scrollbox after `TranscriptList` (not a virtualizer; not TranscriptEntry mutation). Reducer still no `pushLine` on tool-result/permission-denied; still flush on done/turn-ended; error does not flush. recordCall/recordResult aggregation kept.
- Next: promote into `docs/specs/034-tui-tool-transcript/`, then RED App visibility tests, then live-paint.

## 2026-08-27T03:15:00Z EXECUTE (Lionel)
- DECISION: in-place aggregation is for EVERY 034 grouped tool name, not only read_file. TOOL_LABELS (`read_file`, `grep`, `glob`, `bash`, `powershell`, `write_file`, `edit`) all update one line in place. `dispatch_subagents` stays `alwaysAppend`. Do not special-case Read.
- App tests must include at least one non-read same-name case (two bash results before done → one `Ran 2 shell commands`).
- skip: War Room VERIFY opens the PR later.

## 2026-08-27T03:20:00Z EXECUTE (live-paint)
- Path taken: live-paint `renderLiveToolActivity` inside the native scrollbox after `TranscriptList` (full `.map()`, not a virtualizer). Did not mutate `TranscriptEntry`.
- Open-entry filter is name-agnostic (every TOOL_LABELS group). Negative control: 5 App tests failed at 7ef9731 (no `Read a.txt` / `Read 2 files` / `Ran 2 shell commands` / `Searched TODO` until done).
- Gates: lint 0, typecheck 0, `bun run --cwd apps/cli test` 0 (1726 pass), `bun test` 0 (2193 pass).
- skip: War Room VERIFY opens the PR later.
