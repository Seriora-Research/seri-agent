# Feature Plan — TUI live aggregated tool transcript (issue #182)

## Summary
Keep spec 034's name-aggregation and visual language (compact muted lines, cwd-relative paths, `TREE_BRANCH` details/anomalies, write_file/edit approval box, plain CLI untouched). Close only the visibility gap: aggregated `toolActivity` is painted live as calls settle, Claude Code style (same-name calls update one line in place). The reducer still does not `pushLine` on `tool-result` / `permission-denied`; it still flushes into `state.transcript` on `done` / `turn-ended`. `error` still does not flush. No new `TranscriptEntry` variant.

## Choice: live-paint `toolActivity`, do not mutate `TranscriptEntry`

`TranscriptList` (`app.tsx` L657–669) is a full `.map()` of `state.transcript` — not a windowed virtualizer. `LIST_WINDOW_MAX` / `useListWindow` apply to panels, not the transcript. The native `<scrollbox>` (L508–517) is fed the unwindowed array with `stickyScroll` / `stickyStart="bottom"` (header L5–7, L476–478). Extra children laid out after `<TranscriptList />` inside that same scrollbox are real rows: they scroll with the transcript, and sticky-bottom follows them when the user is at the tail.

`pendingTool` (L537–551) and `TurnStatus` (L533–535) sit **outside** the scrollbox on purpose (pinned, always visible). Live aggregated history must **not** join that pinned region — mid-turn scrollback would never include it. Paint it **inside** the scrollbox, after `TranscriptList`, above the pinned `pendingTool` slot.

After `flushToolActivity`, `toolActivity` is `[]`, so the live region unmounts in the same reducer update that `pushLine`s the muted entries into `transcript`. No double paint.

**Rejected:** find-and-update a muted `TranscriptEntry` on each settle (the path 034 rejected). Not needed: the list can show extra rows. Take mutation only if live-paint fails a scroll/sticky check in EXECUTE.

## Decisions (closed — do not reopen)
- **Keep 034 name-aggregation.** Exact tool name, `count`, first-anomaly-only (`appendAnomaly`), grep/glob details dropped when `count>1`, `dispatch_subagents` `alwaysAppend`. In-place live update is for **every** `TOOL_LABELS` name (`read_file`, `grep`, `glob`, `bash`, `powershell`, `write_file`, `edit`) — not a Read special-case. Two `read_file` results mid-turn: the same place shows `Read a.txt` after the first, then `Read 2 files` after the second, **before** `done` / Cooked-for. Two `bash` results: `Ran echo a` then `Ran 2 shell commands`. grep then read_file: two groups, each appearing when that name first settles.
- **Commit point for transcript persistence is still turn-end.** `tool-result` / `permission-denied` still do not `pushLine`. Flush on `done` / `turn-ended`. `error` still does not flush (`loop.ts` can continue).
- **Visibility is real-time.** The user sees the aggregated line as soon as the first call of that group settles, and sees it update on later same-name results. Not wait-until-turn-end, and not N separate per-call transcript lines.
- **No new TranscriptEntry variant.** Flushed lines stay `{ role: "system", text, muted: true }`. Live rows reuse the same muted paint (`theme.muted` + `TREE_BRANCH` in the string).
- **Live `pendingTool` slot unchanged.** write_file/edit bordered warning box; every other name unbordered muted `summarizeArgs`. Box is the in-flight call, not a substitute for settled group history.
- **`dispatch_subagents` stays per-call** (`alwaysAppend`). Keep `toolResultLine` via private `settledSingleLine`. Do not change `recordCall`'s skip for this name (pre-existing 034).
- **grep/glob success `└ ` detail lines stay** on count===1; dropped when count>1, same as 034.
- **Plain CLI / LoopEvent / session data unchanged.** `apps/cli/src/cli/output.ts` has zero diff.
- Successor of spec 034: after approval, Handler promotes this plan into `docs/specs/034-tui-tool-transcript/` (no new spec ID).

## Files to add / modify
| file | action | change |
|------|--------|--------|
| `apps/cli/src/tui/app.tsx` | edit | **Main change.** Inside the `<scrollbox>` (L508–517), after `<TranscriptList transcript={state.transcript} />` (L516), paint `renderToolActivity` of the **settled** view of `state.toolActivity` as muted transcript-looking rows (`<text fg={theme.muted}>`, same as `TranscriptRow` L728). Import `renderToolActivity` (today only `summarizeArgs`, L71). Do not put these rows next to `pendingTool` (L537–551, outside the scrollbox). After flush, `toolActivity === []` → region empty. **Open-entry filter:** `recordCall` increments `count` and sets `open` before the result. Skip `open && count === 1` so the first in-flight call is only `pendingTool`. For `open && count > 1` (follow-up same-name still running), paint with visual count `count - 1` so the line stays `Read a.txt` until the second result lands as `Read 2 files` — matches Lionel's example; do not let the group vanish between 2nd `tool-call` and 2nd `tool-result`. A tiny mapper in `app.tsx` (or a new `renderLiveToolActivity` export) is enough; do not change `recordCall` / `recordResult` / `recordDenial`. Multiline `TREE_BRANCH` strings stay one `<text>` node, same as flushed entries. |
| `apps/cli/src/tui/state/toolActivity.ts` | none (or additive helper only) | Keep find-or-append-by-name, `aggregateLine` (L324–329), `appendAnomaly` (L218–222), grep-details-dropped-when-count>1 (L266–270, L294–296), `dispatch_subagents` skip/`alwaysAppend`. Optional: export a live-view mapper so App does not inline the `open`/`count-1` rule. |
| `apps/cli/src/tui/state/reducer.ts` | comment only | **No `pushLine` on `tool-result` (L634–645) or `permission-denied` (L646–652).** Keep `flushToolActivity` on `done` (L692–697) and `turn-ended` (L500–504). `error` (L702–707) still no flush. `recordCall` on `tool-call` (L627–633) stays. Update `TuiState.toolActivity` comment (L103–107) and the `applyLoopEvent` tool-call comment (L622–626): accumulator is now also the live-paint source during the turn, not only a turn-end buffer. |
| `docs/design/tui.md` | edit | Replace the Tool-call/result transcript passage (L94–102). Keep aggregation (`Read 2 files` / `"Ran 2 shell commands"`). Document live paint of `toolActivity` inside the scrollbox as calls settle, in-place count update, flush into muted transcript on `done`/`turn-ended` (not `error` — today's text wrongly lists `error` as a flush point). `pendingTool` unchanged. |
| `apps/cli/tests/tui/App.test.tsx` | edit | See Test plan. Visibility contract lives here (frame contains the aggregated line before `done`). Keep write_file/edit box tests (L1221, L1242) and pending read_file unbordered muted live line (L1260). |
| `apps/cli/tests/tui/reducer.test.ts` | edit | See Test plan. Change **visibility** assertions, not aggregation. Keep "do not push a transcript line" (L231) and "clears the running status without pushing a transcript line" (L304). Keep `"Read 2 files"` pins (L326, L380). Add a selector assertion: after `tool-result` and before `done`, `renderToolActivity(state.toolActivity)` is already non-empty. |
| `apps/cli/tests/tui/toolActivity.test.ts` | none | Keep aggregation pins: find-or-append-by-name (L346), count>1 (L309–327), two failures → one `TREE_BRANCH` (L387), grep details dropped when count>1 (L353). If a live-view helper is added, test the `open`/`count-1` filter there. |
| `apps/cli/src/cli/output.ts` | none | zero diff |
| `apps/cli/tests/cli/output.test.ts` | none | must pass unchanged |

## Contract / data / API changes
None to `LoopEvent` (`loop.ts` L22–32), session/`--resume`, CLI stdout, `pushLine`, or `TranscriptEntry` (`format.ts` L59 already has `muted?: boolean`). `ToolActivityEntry` (`toolActivity.ts` L15–24) stays as-is, including `count` and `open`. No generator/callback change.

Streaming check: not required for this path — live paint reads `state.toolActivity` already updated on each `tool-result` / `permission-denied`. Discrete events + `pendingTool` args are unchanged.

## Test plan
**Visibility, not aggregation. Do not rewrite 034's aggregation pins.**

**`App.test.tsx` (primary RED):**
- After `tool-call` + `tool-result` of `read_file` and **before** `done`: frame contains compact `Read a.txt` (live `toolActivity` paint). Status/`pendingTool` still clear (`not.toContain("Running read_file…")` at L1154–1170 stays). Do not require a muted `state.transcript` entry.
- After two sequential same-name `read_file` results, before `done`: frame contains `Read 2 files` exactly once, not two `Read a.txt` / `Read b.txt` lines.
- After two sequential same-name `bash` results, before `done`: frame contains `Ran 2 shell commands` exactly once (every `TOOL_LABELS` name, not a Read special-case).
- grep then `read_file`: two live groups, each appearing after that name's first result.
- After `done`: flushed muted transcript lines present; live region gone (no double `Read 2 files`).
- Keep pending `read_file` unbordered muted live line (L1260) and write_file/edit box tests (L1221, L1242). After result, live slot clears; the settled aggregated line is a different row (inside the scrollbox).

**`reducer.test.ts` (keep aggregation contract):**
- KEEP: L231 do not push on tool-call/result/permission-denied; L304 result clears status without a transcript line; L314 single result + done → one muted `Read a.txt`; L326 two same-name + done → one `Read 2 files`; L339 failing bash + done → `TREE_BRANCH`; L361 declined + done → anomaly; L380 error does not flush, later tools still aggregate on done as `Read 2 files`; L408 leftover open call flushes on done; L429 error then turn-ended flushes; L449/457/480 tool-allowed/compacted/retry immediate non-muted.
- ADD: after one `tool-result` and before `done`, `renderToolActivity` of `state.toolActivity` (with the same live filter App uses) equals `["Read a.txt"]` (or equivalent); `state.transcript` still has no muted tool entry.
- ADD: after two same-name results and before `done`, that render is one `Read 2 files` line, not two.

**`toolActivity.test.ts`:** keep all aggregation tests. Do not drop `Read 2 files` / count>1 / find-or-append / first-anomaly-only / grep-details-dropped.

**`output.test.ts`:** zero diff, must pass.
**`tuiPty.test.ts`:** re-run as regression. `childScriptManyLines` (L62–71) still yields 300 `error` events, not results — live `toolActivity` paint does not add 300 rows. Confirm by running. Comment at L58–59 (commit is still turn-end) remains true for `state.transcript`.

**Manual** (`bun run --cwd apps/cli dev` on Lionel's computer): start a turn that runs `read_file` twice. Confirm `Read a.txt` appears when the first returns, then **updates in place** to `Read 2 files` when the second returns, before Cooked-for. grep then read_file: two groups. Mid-turn scrollback includes the settled group while the next call is still in `pendingTool`. Negative control: a turn with no tools has no muted tool lines. Failing bash: one `└ ` under that group. write_file/edit box unchanged. No full absolute Windows path. Plain CLI unchanged if exercised.

## Acceptance criteria
- [ ] After two sequential same-name `tool-result`s and **before** `done`, exactly one muted aggregated line is visible (`Read 2 files` or equivalent) — App test and/or `renderToolActivity(toolActivity)` selector.
- [ ] After a first `tool-result`, that line is already visible (not empty until `done`).
- [ ] Mid-turn scroll/view includes the live aggregated rows (they are scrollbox children, not pinned chrome).
- [ ] `grep -n "Read 2 files"` / `aggregateLine` production path remains in `toolActivity.ts`.
- [ ] Reducer still does not `pushLine` on `tool-result` / `permission-denied` (existing tests still pass).
- [ ] `JSON.stringify(event.args)` still absent from `reducer.ts` (plain CLI `output.ts` L296 only).
- [ ] write_file/edit live approval box tests still pass unchanged.
- [ ] `apps/cli/tests/cli/output.test.ts` zero diff and passes.
- [ ] Full suite + lint/typecheck pass (`SERI_DISABLE_MODELS_FETCH=1 bun test` / `tsc --noEmit` in `apps/cli`; install bun on the VM if missing — `environment.md` notes bun is absent).
- [ ] Manual TUI: in-place aggregation update recorded; negative control recorded.
- [ ] `docs/design/tui.md` documents live aggregated paint + turn-end flush, not per-call `pushLine` and not dropped `Read 2 files`.

## Rollout / rollback
No flag. Additive live-paint of an accumulator 034 already maintains. Rollback: revert the merge commit. Blast radius: `apps/cli/src/tui/app.tsx`, light reducer comments, tui tests, `docs/design/tui.md`. No session/CLI stdout change.

## Risks
| risk | impact | mitigation |
|------|--------|------------|
| Open-entry paint duplicates `pendingTool` on the first in-flight call, or hides the group during a same-name follow-up | Medium | Skip `open && count === 1`; visual count `count - 1` while `open` |
| Live rows placed next to pinned `pendingTool` (outside scrollbox) fail the mid-turn scroll check | High | Paint inside `<scrollbox>` after `TranscriptList` only |
| Double paint at `done` if live region and flushed transcript overlap a frame | Low | Same reducer update: `flushToolActivity` sets `toolActivity: []` then `pushLine`s |
| Sticky-scroll does not follow extra scrollbox children | Low | Confirm in App/pty tests; only then consider TranscriptEntry mutation |
| Implementer rewrites aggregation tests from the previous (rejected) plan | High | This plan: keep `toolActivity.test.ts` and reducer `"Read 2 files"` pins |

## Ordered EXECUTE steps (for tasks.md later)
1. App tests RED: after first `tool-result` before `done`, frame shows `Read a.txt`; after two same-name results, one `Read 2 files`.
2. Paint settled `renderToolActivity` inside the scrollbox after `TranscriptList`; open-entry filter as above; `pendingTool` unchanged.
3. Reducer: comment-only. Add selector tests for live `toolActivity` before `done`. Do not `pushLine` on result/denied. Keep aggregation pins.
4. Update `docs/design/tui.md`.
5. Keep `toolActivity.test.ts` aggregation tests; add helper tests only if a live-view mapper is extracted.
6. Run lint, typecheck, full `apps/cli` test; record exit codes.
