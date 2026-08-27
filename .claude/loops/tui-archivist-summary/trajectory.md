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
