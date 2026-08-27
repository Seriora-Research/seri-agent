# Loop State — tui-archivist-summary
- Mode: feature
- Task: issue #175 — TUI archivist summary renders as raw markdown with no visual framing. Same design family as #173/#174.
- Branch: feat/tui-archivist-summary
- Status: EXECUTE
- Started: 2026-08-27T12:37:00Z  |  Updated: 2026-08-27T12:59:44Z

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
- triggers_fired: none
- tier: 0
- resolution: none — goal was unambiguous. Assumption: plain CLI gets muted/mark treatment, not a second full markdown renderer (TTY/non-TTY still respect NO_COLOR).
- confirmed_goal: The TUI shows the archivist block as secondary (theme.muted + a leading mark, no new hue) and renders report.summary markdown (bold, inline code, lists at minimum) via the existing TUI markdown path, not raw ** / backticks. Plain CLI gets an equivalent restrained treatment. LoopEvent/session payloads unchanged.
- success_check: An ArchivistReport whose summary contains `**bold**` and `code`, applied through the TUI reducer/App, appears muted with a leading mark and does not show literal `**` in the rendered frame. archivistLine/CLI path still emits a stats prefix; output tests cover the CLI shape.

## Plan checklist
- [x] RED App test: additive `transcript-append` fields so the test typechecks; dispatch stats+summary with `**bold**`; assert the GREEN contract (fails on literal `**` still visible).
- [ ] `ARCHIVIST_MARK` + `archivistStatsLine` / `archivistLine`; update `output.test.ts`.
- [ ] Thread `muted`/`markdown` through `pushLine` + `pushTranscriptLine`; two TUI pushes in `cli.ts`; reducer tests for the flags.
- [ ] `TranscriptRow`: muted markdown path (GREEN the App test). Negative system line still raw.
- [ ] `docs/design/tui.md`.
- [ ] lint, typecheck, full `apps/cli` tests; record exit codes.

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
- None. origin/main (PR 183) merged into this branch; no TranscriptRow conflict.
