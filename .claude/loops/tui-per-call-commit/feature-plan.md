# Feature Plan — TUI per-call tool transcript (issue #182)

## Summary
Keep spec 034's visual language (compact muted lines, cwd-relative paths, `TREE_BRANCH` details/anomalies, write_file/edit approval box, plain CLI untouched). Reverse only the commit point: each `tool-result` / `permission-denied` immediately `pushLine`s one muted `TranscriptEntry` so the user sees what the agent is doing in real time. Drop turn-end name-aggregation (`Read 2 files`). No new `TranscriptEntry` variant.

## Decisions (closed — do not reopen)
- **Commit point: per-call.** On `tool-result` and `permission-denied`, `pushLine` one count=1 muted entry (multiline text when `└ ` details/anomalies apply) and drop that entry from `toolActivity`. The user can scroll mid-turn and see completed tools from this turn, in call order, before `done` / Cooked-for.
- **Drop name-aggregation.** Two sequential `read_file` calls produce two muted lines (`Read a.txt`, `Read b.ts`), not `Read 2 files`. First-anomaly-only (`appendAnomaly`, `toolActivity.ts`) and "grep details dropped when count>1" go away because count is always 1 at render time.
- **No new TranscriptEntry variant.** Reuse `{ role: "system", text, muted: true }` (`format.ts`) and existing `TranscriptRow` muted paint (`app.tsx`).
- **`toolActivity` holds only OPEN calls.** Sequential tools (`loop.ts`) ⇒ at most one in-flight entry. `recordCall` on `tool-call` so a thrown execute (tool-call then error, no result) still flushes on `done` / `turn-ended`. Completed calls live in the transcript, not the accumulator.
- **`error` still does not flush** (`loop.ts` can continue). Leftover open call commits on `turn-ended` (or on `done` if the turn ends that way).
- **Live `pendingTool` slot unchanged.** write_file/edit bordered warning box; every other name unbordered muted `summarizeArgs`. Box is not a substitute for the settled per-call history.
- **`dispatch_subagents` already per-call** (`alwaysAppend` on `recordResult`/`recordDenial`). Keep using `toolResultLine` for its settled single-call text (`settledSingleLine`, private). Once `recordCall` always-appends, the skip-`recordCall` + `alwaysAppend` special case is redundant — drop it so a thrown dispatch still flushes; do not change the settled-text source.
- **grep/glob success `└ ` detail lines stay** (up to 3 paths + overflow), now attached to that call's own immediate line, not deferred.
- **Plain CLI / LoopEvent / session data unchanged.** `apps/cli/src/cli/output.ts` has zero diff.
- Successor of spec 034: after approval, Handler promotes this plan into `docs/specs/034-tui-tool-transcript/` (no new spec ID).

## Files to add / modify
| file | action | change |
|------|--------|--------|
| `apps/cli/src/tui/state/reducer.ts` | edit | **`tool-result` (L634–645):** settle the open entry with `recordResult` + `pendingTool?.args`, `pushLine` each `renderToolActivity([settled])` string with `muted: true` (`pushLine` already takes `muted`, L517–522), store remaining `toolActivity` (should be `[]`), clear `pendingTool`/`status`. **`permission-denied` (L646–652):** same with `recordDenial`. **`done` (L692–697):** keep `flushToolActivity` first (leftover open call only), then the `(done: …)` line. **`error` (L702–707):** still no flush; still clear `pendingTool`. **`turn-ended` (L500–504):** keep `flushToolActivity` for leftover. **`tool-call` (L627–633):** keep `flushStreaming`, `pendingTool` for every name, `recordCall`, status `Running ${name}…`. Update comments that currently say turn-end flush: `TuiState.toolActivity` (L103–107), `flushStreaming` (L543–546), `applyLoopEvent` tool-call block (L622–626). Commit is per-call, not deferred. `flushToolActivity` (L556–562) stays as the leftover-open-call helper. |
| `apps/cli/src/tui/state/toolActivity.ts` | edit | Stop find-or-append-by-name (`mapEntry` + `findIndex` by name, L224–236; `recordCall` L251–274). `recordCall` always appends a new open entry (count 1). `recordResult` / `recordDenial` close the matching OPEN entry (the last/only open; sequential invariant) and return settled+remaining — or keep the array API but never merge two completed same-name calls. Delete or stop calling `aggregateLine` (L324–329) / first-anomaly-only cap (`appendAnomaly`, L218–222) in the production path. `renderToolActivity` (L337–344) count===1 path is the only production path (compact `summarizeArgs` / private `settledSingleLine` L238–249 + `detailLines` + one anomaly). Keep `summarizeArgs` (L69), `trimPath` (L63), `detailLinesForResult` (L120), `anomalyLineForResult`/`anomalyLineForDenial` (L182, L206), `escapeControlChars` (imported), `TREE_BRANCH` (`theme.ts` L64). `TOOL_LABELS.noun` exists only for `aggregateLine`; drop with it if `tsc` flags unused. |
| `apps/cli/src/tui/app.tsx` | none | Live slot (L537–551) + `TranscriptRow` muted paint (L728) already correct. No comment still claims turn-end tool flush (the only `turn-ended` mentions, L525–526, are TurnStatus identity). |
| `docs/design/tui.md` | edit | Replace the Tool-call/result transcript passage (L94–102): it currently documents turn-end flush and `"Ran 2 shell commands"` aggregation, and incorrectly lists `error` as a flush point. Replace with per-call: each settled call commits immediately as `theme.muted`; aggregated count lines are gone; leftover open call still flushes on `done`/`turn-ended`; `error` does not flush. |
| `apps/cli/tests/tui/reducer.test.ts` | edit | See Test plan. Current 034 pins are L231–246, L304–312, L326–337, L380–404, L429–447. |
| `apps/cli/tests/tui/toolActivity.test.ts` | edit | See Test plan. Aggregation pins: L309–327, L345–365, L387–395. |
| `apps/cli/src/cli/output.ts` | none | zero diff |
| `apps/cli/tests/cli/output.test.ts` | none | must pass unchanged |

## Contract / data / API changes
None to `LoopEvent` (`loop.ts` L22–32: `tool-result` already carries `name` + `result`; `permission-denied` carries `name` + `reason`), session/`--resume`, or CLI stdout. `TranscriptEntry` already has `muted?: boolean` (`format.ts` L59). `ToolActivityEntry` (`toolActivity.ts` L15–24) may drop fields only used for aggregation (`count` can stay at 1; do not keep `count>1` production behavior). `pushLine` signature unchanged (already `muted = false`).

Streaming check: `applyLoopEvent` already receives discrete `tool-result` events with `name` + `result`; `pendingTool` (L102, set on `tool-call` L631) holds args. Immediate `pushLine` on that event is realizable with current types. No generator/callback change.

## Test plan
**`reducer.test.ts` (rewrite 034 turn-end pins):**
- DELETE/replace:
  - `tool-call, tool-result, and permission-denied do not push a transcript line` (L231)
  - `a tool-result clears the running status without pushing a transcript line` (L304)
  - `two same-name successful results followed by done produce one aggregated-count entry` (L326; asserts `"Read 2 files"`)
  - `a mid-turn error does not flush toolActivity; later tools still aggregate on done` (L380; asserts `"Read 2 files"`)
  - `error then turn-ended without done flushes accumulated toolActivity` (L429; currently tool-call + **result** + error + turn-ended — keep the leftover-open-call part, drop aggregation; rewrite so the flush case is tool-call with **no** result)
- Keep and retarget to *before* `done` (they currently wait until `done`):
  - `a single successful tool-result followed by done produces one muted entry with no raw JSON` (L314)
  - `a failing bash result followed by done produces a TREE_BRANCH-prefixed anomaly line` (L339)
  - `a declined permission-denied followed by done produces an anomaly line and does not throw` (L361)
- Keep: `a tool-call followed by error (no tool-result) still flushes a settled line on done` (L408) — leftover open call via `done` rather than `turn-ended`.
- Keep: `a tool-call flushes pending streamed text, sets pendingTool for a non-write tool, and does not push raw JSON` (L293) — still no tool line on `tool-call` itself.
- ADD:
  - `tool-result` of `read_file` pushes one `muted: true` entry immediately; transcript contains it BEFORE a subsequent `done`; text is compact (`Read a.txt` via `summarizeArgs`), no raw JSON.
  - two sequential different or same-name tools → two muted entries after the second result, still before `done`. Order = call order.
  - `permission-denied` (declined) pushes a muted line with a `TREE_BRANCH` anomaly immediately.
  - failing `bash` (`exitCode: 1`) pushes muted summary + one `└ ` anomaly immediately.
  - `tool-call` still does not push a tool line (only `pendingTool` / `recordCall`); live slot remains the in-flight UI.
  - `error` after `tool-call` (no result) does not push the tool line; `turn-ended` then flushes the leftover open call as one muted line.
  - `error` after a successful `tool-result` does not duplicate or drop that already-committed line.
  - `tool-allowed` / `compacted` / `retry` still immediate non-muted `pushLine` (existing L449, L457, L480).
  - `done` after two already-flushed results does not add extra tool lines (flush of empty accumulator is a no-op), only the `(done: …)` line.

**`toolActivity.test.ts`:** drop/replace pins for find-or-append-by-name (`recordCall find-or-appends by name`, L346), count>1 aggregate (`count > 1 is a pure aggregate` L309, `count > 1 still attaches an anomaly line` L316), two failures → one TREE_BRANCH (`two failing results in one name-group emit exactly one TREE_BRANCH line` L387), grep details dropped when count>1 (`recordResult on two same-name calls drops grep detail lines` L353). Keep `trimPath`, `summarizeArgs`, `detailLinesForResult`, anomaly helpers, count===1 render (with and without `└ `) — L46–307, L374–385. `dispatch_subagents is never aggregated` (L367) stays true as two sequential calls → two entries; retitle if needed.

**`App.test.tsx`:** keep pending read_file unbordered muted live line (L1260); keep write_file/edit box tests (L1221, L1242). After result, live slot clears (L1154–1170: `not.toContain("Running read_file…")` stays). Do not assert absence of the new settled `Read a.txt` in the transcript.

**`output.test.ts`:** zero diff, must pass.
**`tuiPty.test.ts`:** re-run as regression (034 already switched 300 tool-calls → 300 errors at L55–61). Per-call now DOES add transcript lines per result — this fixture still hammers `error` without results (`childScriptManyLines`, L62–71), so viewport math stays valid. Confirm by running, do not assume. The comment at L58–59 ("tool-call/result no longer land in the transcript until turn-end") is stale; update it if the file is opened for a real failure, not as a drive-by.

**Manual** (`bun run --cwd apps/cli dev` on Lionel's computer): start a turn that runs grep then read_file. Confirm each compact muted line appears when that tool returns, before Cooked-for. Confirm mid-turn scrollback shows the completed first tool while the second is still pending. Negative control: a turn with no tools still has no muted tool lines. Failing bash still gets one `└ ` under that call immediately. write_file/edit box unchanged. No full absolute Windows path. Plain CLI path visually unchanged if exercised.

## Acceptance criteria
- [ ] After one `tool-result` and before `done`, reducer state has ≥1 `muted: true` transcript entry (unit test).
- [ ] Two sequential tools → two muted entries before `done`, call order, not one aggregate line (unit test).
- [ ] `grep -n "Read 2 files"` / aggregate-count production path is gone from `toolActivity.ts` (or unreachable).
- [ ] `JSON.stringify(event.args)` still absent from `reducer.ts` (today it lives only in plain CLI `output.ts` L296).
- [ ] write_file/edit live approval box tests still pass unchanged.
- [ ] `apps/cli/tests/cli/output.test.ts` zero diff and passes.
- [ ] Full suite + lint/typecheck pass (`SERI_DISABLE_MODELS_FETCH=1 bun test` / `tsc --noEmit` in `apps/cli`; install bun on the VM if missing — `environment.md` notes bun is absent on the Cursor VM).
- [ ] Manual TUI: per-call lines appear in real time; negative control recorded.
- [ ] `docs/design/tui.md` documents per-call, not turn-end.

## Rollout / rollback
No flag. Straight replacement of 034's commit point. Rollback: revert the merge commit. Blast radius: `apps/cli/src/tui/**`, tui tests, `docs/design/tui.md`. No session/CLI stdout change.

## Risks
| risk | impact | mitigation |
|------|--------|------------|
| Long turns now append many muted lines (no aggregate) | Low/Medium — noisier than 034, which is the point | Accept; compactness is per-line, not per-turn |
| `tuiPty` 300-result viewport if tests start emitting results | Low | Run the test; fix only if it fails. Current fixture (`tuiPty.test.ts` L62–71) yields 300 `error` events, not results |
| Leftover open call (tool-call then throw) could duplicate if we also push on a later result | Low | Sequential invariant; result clears the open entry; error does not push |
| Forgetting to drop aggregation tests would leave false greens | High | Rewrite the five reducer pins listed above (L231, L304, L326, L380, L429) |

## Ordered EXECUTE steps (for tasks.md later)
1. Rewrite reducer tests RED for per-call (assert muted line on tool-result before done; two calls → two lines; no aggregate).
2. Change `tool-result` / `permission-denied` in `applyLoopEvent` to immediate muted `pushLine`; keep `recordCall` + leftover flush on `done`/`turn-ended`; `error` non-flush.
3. Simplify `toolActivity.ts`: no name-aggregation; count===1 render only; keep helpers.
4. Update `docs/design/tui.md`.
5. Fix remaining unit tests (`toolActivity.test.ts`, App comments).
6. Run lint, typecheck, full `apps/cli` test; record exit codes.
