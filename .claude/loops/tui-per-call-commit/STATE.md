# Loop State — tui-per-call-commit
- Mode: feature
- Task: issue #182 — TUI shows aggregated tool-call/result lines in real time as calls settle (Claude Code in-place update). Successor to spec 034 / issue 173 / PR 181.
- Branch: feat/tui-per-call-commit
- Status: EXECUTE
- Started: 2026-08-27T02:58:00Z  |  Updated: 2026-08-27T03:12:00Z

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
- resolution: DECISION: keep name-aggregation, live in-place update, do not drop Read 2 files. Lionel rejected Scout's drop-aggregation plan (War Room 2026-08-27). Keep 034 visual language and aggregation; close only the visibility gap (live-paint `toolActivity` inside the scrollbox). Transcript persistence still flushes on done/turn-ended; error does not flush.
- confirmed_goal: TUI shows aggregated tool-call/result lines in real time as calls settle, Claude Code style: same-name calls update one line in place; the user can see what the agent is doing mid-turn. Live pending slot remains for the in-flight call. write_file/edit box and plain CLI unchanged.
- success_check: After two sequential same-name tool-results and BEFORE done, exactly one muted aggregated line is visible (`Read 2 files` or equivalent). After a first result, that line is already visible (not empty until done). A mid-turn scroll/view includes it.

## Plan checklist
- [x] App tests RED: after first `tool-result` before `done`, frame shows `Read a.txt`; after two same-name results, one `Read 2 files`; two bash results → one `Ran 2 shell commands`.
- [x] Paint settled `renderToolActivity` inside the scrollbox after `TranscriptList`; open-entry filter; `pendingTool` unchanged.
- [x] Reducer: comment-only. Add selector tests for live `toolActivity` before `done`. Do not `pushLine` on result/denied. Keep aggregation pins.
- [x] Update `docs/design/tui.md`.
- [x] Keep `toolActivity.test.ts` aggregation tests; add helper tests only if a live-view mapper is extracted.
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
