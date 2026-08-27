# Trajectory — tui-archivist-summary

## 2026-08-27T12:37:00Z INIT
- Mode: feature
- Issue: https://github.com/lzvxck/seri-agent/issues/175
- Branch: feat/tui-archivist-summary
- Next: EXPLORE then feature-plan. Same design family as #173/#174. Parallel with open PR 183 (toolActivity live-paint on app.tsx); rebase onto main after 183 merges if needed.

## 2026-08-27T12:44:32Z PLAN
- Wrote `.claude/loops/tui-archivist-summary/feature-plan.md` from the War Room plan; filled real file:line from `feat/tui-archivist-summary` @ 5980f8c. Architecture unchanged (no new TranscriptEntry variant; two TUI entries / one CLI string; `ARCHIVIST_MARK` not `WARNING_MARK`; muted markdown on the system+muted path, not assistant `●`; `ARCHIVIST_PROMPT` / LoopEvent / ArchivistReport untouched).
- STATE.md Status → PLAN. Plan checklist filled from the six ordered EXECUTE steps.
- Do not promote to `docs/specs/035-tui-archivist-summary/` until Handler says so.
- Next: human approval, then EXECUTE.

## 2026-08-27T12:59:44Z EXECUTE
- Merged `origin/main` (PR 183 live-paint + PR 184 roadmap) into `feat/tui-archivist-summary`. No TranscriptRow conflict; both 183 `renderLiveToolActivity` and the planned muted-markdown branch remain in scope.
- Promoted approved feature-plan to `docs/specs/035-tui-archivist-summary/{spec,tasks}.md`. Did not edit `docs/ROADMAP.md`.
- STATE.md Status → EXECUTE. Six EXECUTE steps start unchecked; check off as each lands.
- Next: ordered EXECUTE steps 1–6. skip: War Room VERIFY opens the PR later.

## 2026-08-27T13:02:00Z EXECUTE step 1
- Additive `transcript-append` `muted?`/`markdown?` on `TuiAction` (not yet threaded through `pushLine`). Exported `ARCHIVIST_MARK` so the App test can dispatch the planned stats prefix.
- RED: `an archivist stats+summary block is muted with a leading mark and conceals markdown markers` failed at `expect(frame).not.toContain("**")`. Frame still showed `recorded **bold** fact` (TranscriptRow paints system lines as plain text). Negative control recorded.
- Negative system-line test passed (literal `**not-bold**`, `theme.text`).

## 2026-08-27T13:04:00Z EXECUTE step 2
- Extracted `archivistStatsLine`; `archivistLine` prefixes `ARCHIVIST_MARK` and still indents a defined summary. `output.test.ts` pins the mark and the stats-only equality.

## 2026-08-27T13:06:00Z EXECUTE step 3
- Threaded `muted`/`markdown` through `pushLine` and `pushTranscriptLine`. TUI archivist is two pushes (muted stats, optional muted markdown summary). Reducer test pins omit-when-false. App test still RED on literal `**`.

## 2026-08-27T13:08:00Z EXECUTE step 4
- TranscriptRow paints `role === "system" && muted && markdown` via existing `<markdown fg={theme.muted}>` (no ●, no BULLET_GUTTER). `renderLiveToolActivity` unchanged.
- GREEN: the App test that failed on literal `**` at 7571a1f now passes. Negative system line still shows `**not-bold**` at `theme.text`.
