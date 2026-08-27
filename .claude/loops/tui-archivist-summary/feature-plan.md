# Feature Plan — TUI archivist summary framing + markdown (issue #175)

## Summary
Make the archivist report read as a secondary note: `theme.muted` plus a leading mark (no new hue), and render `report.summary` markdown in the TUI via the existing `<markdown>` path. Do not use `role: "assistant"` (that adds `●` and answer-weight). Plain CLI gets the same mark + indent, still raw markdown source (no second renderer).

## Decisions (closed)
- **No new TranscriptEntry variant.** Reuse `{ role: "system", text, muted: true }` from 034/#181 (`format.ts` L59). Add one more optional flag, `markdown?: boolean`, on the same object.
- **Do not reuse the assistant TranscriptRow branch** (`app.tsx` L699–719). That path paints `●` (`BULLET` L676) via an overlay and `fg={theme.text}`. Paint muted markdown on the system+muted path: `<markdown fg={theme.muted} content={...} syntaxStyle={syntaxStyle} treeSitterClient={getTreeSitterClient()} streaming={false}>` when the entry is `role === "system" && muted && markdown`. No `paddingLeft={BULLET_GUTTER}`, no bullet.
- **Two TUI entries, one CLI string.** Stats line is plain muted text with `ARCHIVIST_MARK`. Summary (when defined) is a second muted system entry whose text is the summary (raw `report.summary`, no `"  "` indent) and is painted with `<markdown>`. Avoid feeding `(archivist: …)` into the markdown parser. CLI keeps a single `archivistLine` string: mark + stats + optional `\n  ${summary}`.
- **Extend `transcript-append`** (`reducer.ts` L232, case L359–360) with `muted?: boolean` and `markdown?: boolean`, threaded into `pushLine` (L517–528). Additive fields, not a new role. Tool-activity already mutes via internal `pushLine(..., true)` at L559; this action is how `cli.ts` pushes the archivist (`pushTranscriptLine` L2115–2117, call site L2884–2886).
- **Leading mark:** add `ARCHIVIST_MARK` in `theme.ts` next to `WARNING_MARK` (L60) / `TREE_BRANCH` (L64). Do **not** reuse `WARNING_MARK` (`"! "`) — that means write approval. ASCII-or-existing-secondary-glyph, no hue. Use `· ` (U+00B7 MIDDLE DOT + space), the same separator glyph already in TUI chrome (`format.ts` L356 ` · `, hint rows). Trailing space matches `ERROR_MARK`/`WARNING_MARK`/`TREE_BRANCH`. Stats line becomes `${ARCHIVIST_MARK}(archivist: …)`. Unlike `WARNING_MARK` (comment L56–58: TUI call site only, never a shared formatter), this mark **does** belong in `archivistLine` so CLI and TUI stats match.
- **Do not change `ARCHIVIST_PROMPT`** (`archivist.ts` L21). Markdown in summaries is empirical; a prompt nudge is out of scope.
- **Not a LoopEvent.** Keep `pushTranscriptLine` / `transcript-append` after `maybeRunArchivist` (`cli.ts` L2084, L2884–2886). Fallback summaries stay omitted (`summary === undefined` → stats only; `ArchivistReport.summary` L181–188).
- **CLI is in scope** (unlike 173/034). Restrained: same mark + existing indent; still raw `**` in a pipe/non-TTY. Respect NO_COLOR as today — `archivistLine` is a plain string with no color codes (`output.ts` L448–457); do not add any.
- **Bold / inline-code / lists** are the markdown floor (existing assistant `<markdown>` already does this, `app.tsx` L710–717 + `syntaxStyle.ts`). No new markdown engine. Reuse the same `syntaxStyle` import (`app.tsx` L72). Inline code will use `theme.code` (already a documented hue exception in `tui.md` L42–46 / `theme.ts` L48–53) — do not invent a muted-only SyntaxStyle.
- After approval, promote to **new** spec `docs/specs/035-tui-archivist-summary/` (not into 034). Handler promotes; this PLAN does not.

## Files to add / modify
| file | action | change |
|------|--------|--------|
| `apps/cli/src/tui/theme/theme.ts` | edit | Export `ARCHIVIST_MARK = "· "` immediately after `TREE_BRANCH` (L64), with a one-line comment matching TREE_BRANCH's style (secondary-detail glyph, not a color). Note that this mark **is** applied inside `archivistLine` (shared CLI+TUI formatter), unlike `WARNING_MARK`. No new color token. |
| `apps/cli/src/tui/util/format.ts` | edit | `TranscriptEntry` (L59) gains `markdown?: boolean`. Keep `muted?: boolean`. No other change. |
| `apps/cli/src/tui/state/reducer.ts` | edit | `TuiAction` `"transcript-append"` (L232) gains `muted?: boolean; markdown?: boolean`. Case L359–360 currently calls `pushLine(state, action.line, action.role ?? "system", action.flush ?? true)` — pass `action.muted ?? false` and `action.markdown ?? false` as the 5th/6th args. `pushLine` (L517–523) gains a 6th param `markdown = false`. Entry construction (L528) currently omits the `muted` key when false (`muted ? { role, text: line, muted: true } : { role, text: line }`) — keep that omit-when-false shape and also omit `markdown` when false, so existing `toEqual` pins (`reducer.test.ts` L57–59, L89–92) stay byte-identical. Internal `pushLine(..., true)` at L559 (tool-activity flush) is unchanged (6th arg defaults false). |
| `apps/cli/src/tui/app.tsx` | edit | In `TranscriptRow` (L698–728): after the user branch (L721–727) and before the current fallback (L728 `<text fg={entry.muted ? theme.muted : theme.text}>{entry.text}</text>`), add: `role === "system" && entry.muted && entry.markdown` → `<markdown fg={theme.muted} content={entry.text} syntaxStyle={syntaxStyle} treeSitterClient={getTreeSitterClient()} streaming={false} />`. No `BULLET`, no `BULLET_GUTTER`, no wrapper box required (no overlay). System+muted plain → current muted `<text>` at L728. Other system lines (unmuted, including errors/`(done: …)`/`⚙ compacted`) unchanged. Update the header comment (L679–693) that currently says everything else stays plain text: carve out this one muted-markdown exception (archivist summary), keep the "tool results must not be markdown-parsed" rationale for the default. |
| `apps/cli/src/cli.ts` | edit | TUI call site L2884–2886 currently `pushTranscriptLine(dispatch, archivistLine(result.archivist))` — one multi-line system entry, unmuted, not markdown. Replace with two pushes: stats via `archivistStatsLine(result.archivist)` with `{ muted: true }`; if `result.archivist.summary !== undefined`, push that string with `{ muted: true, markdown: true }`. Extend `pushTranscriptLine` (L2115–2117) to forward optional `{ muted?: boolean; markdown?: boolean }` onto the action; every other caller (`tuiPresenter` L2142, quit L2985) stays default. CLI call site L3735: `console.log(archivistLine(archivist))` still one string. Import `archivistStatsLine` next to `archivistLine` (L35). Update the L2361–2364 / L2880–2883 comments that currently say the live transcript push is `archivistLine` as one string. |
| `apps/cli/src/cli/output.ts` | edit | Extract `archivistStatsLine(report)` that returns `${ARCHIVIST_MARK}${stats}` from the existing stats construction (L449–455). `archivistLine` (L448–457) becomes `const stats = archivistStatsLine(report); return report.summary === undefined ? stats : \`${stats}\\n  ${report.summary}\``. Import `ARCHIVIST_MARK` from `../tui/theme/theme` (theme.ts is type-import-only of `PermissionMode`; no spawnCollect / child_process — satisfies this file's L6–10 import bar). Update the L433–447 comment: TUI no longer wraps the full `archivistLine` string; CLI still does. |
| `docs/design/tui.md` | edit | Document the archivist block next to the existing "weight and a mark, not color" / tool-transcript passages (approval box L104–108; tool-call/result L94–102): muted + `ARCHIVIST_MARK` (`· `), markdown summary via existing `<markdown>`, secondary to the assistant reply. Stats line is not markdown-parsed. CLI is the same mark + indent, raw source. No new hue. |
| tests | edit | See Test plan. |
| `apps/cli/src/memory/archivist.ts` | none | no prompt change (`ARCHIVIST_PROMPT` L21; `ArchivistReport` L181–192; `maybeRunArchivist` L299). |

## Contract / data / API changes
None to LoopEvent, ArchivistReport, session data. Additive TUI entry flags (`TranscriptEntry.markdown?: boolean`) and `transcript-append` fields (`muted?`, `markdown?`). `pushLine` gains a 6th defaulted param; `pushTranscriptLine` gains an optional opts bag. `archivistLine` CLI string gains a leading mark — update the two `output.test.ts` pins (L83–86, L95–97). New export `archivistStatsLine` for the TUI stats entry (same stats body as `archivistLine`, with the mark, no summary).

Streaming: not required. Archivist push is a one-shot after `maybeRunArchivist` (`cli.ts` L2084 then L2884–2886). Types already expose the full `ArchivistReport` at that point (`summary: string | undefined` at `archivist.ts` L188). Two discrete `transcript-append` dispatches are realizable with the additive action fields; no generator/callback change.

`tuiPty.test.ts` substring waits on `"(archivist:"` (L1604, L6075, L6085, L6099) stay valid — the mark is a prefix, not a replacement of that substring. Do not retarget those tests unless they fail.

## Test plan
- `output.test.ts` (L78–99): update the two `archivistLine` cases for the mark. L94–97 (`summary: undefined`) currently `toBe("(archivist: tool-count trigger, 1 tool call, tokens: 100 in, 20 out)")` and `not.toContain("\n")` — becomes `` `${ARCHIVIST_MARK}(archivist: tool-count trigger, 1 tool call, tokens: 100 in, 20 out)` ``, still no newline. L82–86 (defined summary) still `toContain` the raw text `"recorded that this repo uses pnpm"` and `"archivist: tool-count trigger"`; also `toContain("\n  ")` (existing indent). Optionally pin `archivistStatsLine` equals the undefined-summary `archivistLine` (same string, no newline).
- `reducer.test.ts` (`describe("tuiReducer: transcript-append")` L49): add: `transcript-append` with `muted: true` / `markdown: true` lands those keys on the entry (`{ role: "system", text, muted: true, markdown: true }`). Default (no flags) still `{ role: "system", text }` unmuted, no `markdown` key — keep L50–61 as the regression for other appends (`tuiPresenter`, quit, `/mode`). Do not weaken L77–94 (flush-streaming-before-append).
- `App.test.tsx` (RED then GREEN): dispatch an archivist stats+summary with `**bold**` in summary. Pattern to copy: assistant markdown conceal test L871–897 (`flushMarkdown` from `helpers.ts` L99–117; `not.toContain("**bold text**")` + `toContain("bold text")`); muted-span check L1260–1276 (`parseColor(theme.muted)`); bullet absence vs assistant `●` tests L1019–1151.
  - Positive: `dispatch({ type: "transcript-append", line: `${ARCHIVIST_MARK}(archivist: tool-count trigger, 1 tool call)`, muted: true })` then `dispatch({ type: "transcript-append", line: "recorded **bold** fact", muted: true, markdown: true })`. `flushMarkdown` until the frame includes `"recorded"` and `"bold"`. Assert: literal `**` absent; `"bold"` present; leading `· ` / `ARCHIVIST_MARK` present; `(archivist:` present; no `●` on that block (the archivist lines must not start with `●`); stats/`(archivist:` span is `theme.muted` (and the summary prose too if a span is locatable).
  - Negative: a normal system error/status line (`dispatch({ type: "transcript-append", line: "boom **not-bold**" })` with no flags) still shows literal `**not-bold**` and is not forced muted (`fg` is `theme.text`, not `theme.muted`).
  - Sequencing note: the GREEN dispatch shape needs the new action fields to typecheck. Land the additive `transcript-append` fields first (no render change) so the test compiles and fails on the frame (literal `**` still visible because `TranscriptRow` L728 ignores `markdown`). Then the TranscriptRow branch turns it green. Do not write the test against today's one-string `archivistLine` append and then rewrite it — that wastes a pin.
- `archivist.test.ts`: unchanged (summary defined, not render). `maybeRunArchivist` describe at L349.
- Manual: trigger archivist in TUI; block looks secondary (muted + `· `); markdown renders; CLI `console.log` path if easy (`cli.ts` L3735). Record SKIPPED if this VM has no interactive TUI session (same convention as STATE.md Manual test).

## Acceptance criteria
- [ ] TUI archivist summary with `**x**` does not show literal `**`
- [ ] Block is `theme.muted` + `ARCHIVIST_MARK`; no new hue; no assistant bullet
- [ ] Stats line is not markdown-parsed (separate entry or equivalent)
- [ ] `summary === undefined` → stats only
- [ ] CLI `archivistLine` has the mark; output tests updated and passing
- [ ] LoopEvent / ArchivistReport / prompt unchanged
- [ ] lint, typecheck, full apps/cli tests pass
- [ ] `docs/design/tui.md` updated

## Rollout / rollback
No flag. Revert the merge. Blast: tui (`theme.ts`, `format.ts`, `reducer.ts`, `app.tsx`) + `archivistLine` / `archivistStatsLine` + `cli.ts` call sites (`pushTranscriptLine` L2115, TUI L2884–2886, CLI L3735) + tests + `tui.md`.

## Risks
| risk | impact | mitigation |
|------|--------|------------|
| Markdown component on muted system looks too heavy | Medium | `fg={theme.muted}`, no `●`, no `BULLET_GUTTER` |
| `WARNING_MARK` reused, confused with write approval | High | dedicated `ARCHIVIST_MARK`; do not import `WARNING_MARK` here |
| PR 183 also edits `app.tsx` TranscriptRow | Medium | this branch is from `main` @ b42c547 (PR 181 / spec 034). Parallel `feat/tui-per-call-commit` (issue #182 / PR 183) also touches TranscriptRow. Rebase onto `main` after 183 merges if needed; conflict should be the muted fallback at L728, not a semantic clash |
| CLI still shows raw `**` | Low | accepted; 175 CLI = mark+indent, not a renderer |
| `output.ts` importing `theme.ts` looks like a layering inversion | Low | one constant, no React; alternative (duplicating the glyph) would drift. Comment on `ARCHIVIST_MARK` states the shared-formatter intent |
| Inline code in a muted summary uses `theme.code` (blue) | Low | existing `<markdown>` + `syntaxStyle` floor; do not add a second SyntaxStyle |
| `tuiPty` exact-string wait on `(archivist:` | Low | substring still matches with a prefix mark; run, don't retarget unless red |

## Ordered EXECUTE steps
1. RED App test: additive `transcript-append` fields so the test typechecks; dispatch stats+summary with `**bold**`; assert the GREEN contract (fails on literal `**` still visible).
2. `ARCHIVIST_MARK` + `archivistStatsLine` / `archivistLine`; update `output.test.ts`.
3. Thread `muted`/`markdown` through `pushLine` + `pushTranscriptLine`; two TUI pushes in `cli.ts` L2884–2886; reducer tests for the flags.
4. `TranscriptRow`: muted markdown path (GREEN the App test). Negative system line still raw.
5. `docs/design/tui.md`.
6. lint (`tsc --noEmit`), typecheck (same), full `SERI_DISABLE_MODELS_FETCH=1 bun test` in `apps/cli`; record exit codes. bun is not on this VM PATH (`environment.md`); install or use the project-local bun before the gate.
