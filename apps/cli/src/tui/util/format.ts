// Pure formatting helpers for the TUI — zero Ink/React import, the same "testable without a
// terminal" property reducer.ts already has.

import { isZeroPriceEntry, type ModelCatalogEntry, type ModelProvider } from "@seri/model-catalog";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { escapeControlChars } from "../../cli/output";
import type { ResolvedRoute } from "../../provider/routing";
import type { ModelPickerEntry, SetupProviderRow } from "../state/commands";
import { theme } from "../theme/theme";

// Shared by every list panel (ModelPicker, ConfigPanel, PermissionsPanel, SetupPanel) via
// useListWindow.ts — the most any of their windows ever shows at once, regardless of how many
// entries/rows match the current filter. The catalog easily runs into the hundreds (models.dev's
// own OpenRouter listing), and rendering all of them would scroll the panel itself out of view, the
// same reasoning truncateArgsDisplay already applies to a single long line; `LIST_WINDOW_MAX` is the
// ceiling on a tall terminal, `MIN_LIST_WINDOW` (below) the floor on a short one. `selectedIndex` can
// move past this many rows (arrow-key navigation over the full filtered list, not just what's on
// screen) — see `slideWindow`/`useListWindow.ts` for how the visible window slides to keep it in
// view.
// `MIN_LIST_WINDOW` is a floor for a short terminal, not a value any of today's real panels reach
// (SetupPanel's own 5 providers already fits under it) — enough rows that a floor-clamped panel
// still shows more than one entry at a time. `PANEL_CHROME_ROWS` is how much of a panel's own
// height is spent on its border, header/filter line, and "+N more" footer rather than list rows —
// sized against ConfigPanel's own list step, the tallest of the four: unlike PermissionsPanel/
// SetupPanel, it can render a "+N more" footer AND a selectedDescription line at once (one row
// each), on top of the border/header/hint every panel already has.
export const LIST_WINDOW_MAX = 10;
export const MIN_LIST_WINDOW = 3;
export const PANEL_CHROME_ROWS = 9;

// Every row a panel's own budget has to share with the rest of App.tsx's render, reserved
// unconditionally rather than threaded through as props: the unconditional mode-indicator row, a
// `commandError` line (one row, shown above the panel), and AuthBanner's three-row bordered Box
// (shown above everything when signed out) — 1 + 1 + 3 = 5. Unconditional because
// `commandError`/`authOffer` live on reducer state inside App, out of scope for the four panel
// components that call `useListWindow(rows, selected)` with nothing else in scope — threading both
// flags into every one of them (plus App itself) costs far more than the alternative:
// over-reserving these five rows when neither is actually showing costs at most one list row on a
// 24-row terminal and nothing at all on a 25+ row one, while under-reserving pushes a panel row off
// the alt screen with no scrollback to recover it.
//
// Does NOT also reserve for `pendingTool`'s own three-row bordered Box, even though a panel can
// genuinely be open while a write_file/edit call is in flight (/model, /setup, /config, and
// /permissions are all handled before the turnInFlight guard) — tried once (bumping this to 8) and
// reverted: on a real 24-row terminal, that shrank the /model picker's default window from 9 rows
// to 6, pushing the bundled fallback manifest's own default model (one of only 6 groq entries in a
// 350-entry catalog) out of the picker's default unfiltered view — a real, more commonly hit
// regression than the pendingTool overflow it was meant to close. Left as a known gap rather than
// re-fixed here; a real fix needs either a shorter LIST_WINDOW_MAX floor or measuring pendingTool's
// own height live instead of reserving for it unconditionally.
export const APP_CHROME_ROWS = 5;

// The transcript viewport's placeholder height for the one frame before `onSizeChange` has ever
// measured the live region below it (App.tsx) — not the real budget, just enough that the first
// frame renders a plausible slice of the transcript instead of an empty one.
export const FALLBACK_CHROME_ROWS = 6;

// Hard-wraps `text` to `columns` VISUAL rows, ANSI-aware (a bash/git tool result can carry real
// color codes, and wrap-ansi tracks them across the break rather than losing the reset). `hard:
// true` force-breaks a single word/token longer than `columns` (an unbroken path or URL) instead of
// overflowing it. `trim: false` keeps leading whitespace exactly as written: tool output routinely
// carries meaningful indentation (a diff, a code snippet), and wrap-ansi's own default trims it.
// `Math.max(1, columns)`: a genuinely zero-width terminal (a resize race, an odd PTY state — real,
// not hypothetical: `stdout.columns` can report 0 for a real pty's first render or two) would
// otherwise hand wrap-ansi a 0 budget, which it accepts silently and degrades to one character per
// row rather than throwing — a defensive floor here regardless of what upstream substitution
// `resolveWidth` (App.tsx) already applies. Always returns at least one entry, even for `""`, so
// an intentional blank separator line survives as one.
//
// This is called from `transcript`'s OWN read path (visibleTranscript/transcriptVisualRows, below)
// and the transcript never stores its own wrapped output — deliberately: a hard-wrap break is
// indistinguishable from a real `\n` once written, so a version that wrapped at write time could
// never correctly re-wrap on a resize (there is no way to un-wrap what was already split). Deriving
// from the untouched logical lines on every read is what makes a resize free instead of lossy.
export function wrapForTranscript(text: string, columns: number): string[] {
  return wrapAnsi(text, Math.max(1, columns), { hard: true, trim: false }).split("\n");
}

export type TranscriptRole = "user" | "assistant" | "system";
export type TranscriptEntry = { role: TranscriptRole; text: string };
// One wrapped/visual line of a TranscriptEntry — same shape today, kept as its own name since a
// logical entry and its visual rows are conceptually distinct (one entry wraps to N rows).
export type VisibleRow = TranscriptEntry;

// The string an entry actually wraps/renders as — assistant entries get the `●` marker prefixed
// here, at read time, rather than stored in the entry's own `text`. `transcriptVisualRows` and
// `visibleTranscript` both funnel through this one helper so they can never disagree on how many
// visual rows an assistant entry occupies (a divergence there would drift the scroll-offset math).
function displayText(entry: TranscriptEntry): string {
  return entry.role === "assistant" ? `● ${entry.text}` : entry.text;
}

// The total number of VISUAL rows `entries` (logical, unwrapped) occupies at `columns` wide — what
// the scroll clamp (reducer.ts's `transcript-scroll`/`transcript-scroll-to`/`viewport-resized`
// cases) needs to know the real maximum offset. O(transcript length): fine on a keypress/resize
// (the only callers), not fine per-render, which is exactly why `visibleTranscript` below does NOT
// call this — it only ever wraps the tail slice it actually needs.
export function transcriptVisualRows(entries: TranscriptEntry[], columns: number): number {
  let total = 0;
  for (const entry of entries) total += wrapForTranscript(displayText(entry), columns).length;
  return total;
}

// Wraps a streamed-answer string the same way a committed assistant entry wraps, via
// `displayText`. No production call site passes anything through this today — app.tsx never
// renders `state.streaming` live (its own file-header comment explains why: the TUI buffers a
// turn's whole answer and reveals it atomically on commit instead of streaming it incrementally).
// Kept, along with `visibleTranscript`'s own `pendingRows` parameter below, because this file's own
// pure-function tests still exercise both directly — not because anything today wires them
// together at render time.
export function wrapPendingRows(pending: string, columns: number): VisibleRow[] {
  const pendingEntry: TranscriptEntry = { role: "assistant", text: pending };
  return wrapForTranscript(displayText(pendingEntry), columns).map((text) => ({
    role: pendingEntry.role,
    text,
  }));
}

// The visible slice of a committed transcript for a viewport `rows` tall, `offset` VISUAL rows up
// from the newest (0 = following the latest line). Tail-anchored, not head-anchored: a transcript
// longer than the viewport keeps showing its NEWEST rows by default, the same thing the terminal
// itself would show if these lines had just scrolled by normally.
//
// Walks `entries` from the newest entry backward, wrapping each one, stopping as soon as
// `offset + rows` visual rows have accumulated (or the transcript runs out) — bounded by how deep
// the reader has scrolled, not by total session length, so this stays cheap on every render of a
// long-running session (called once per streamed token while a turn is in progress) instead of
// re-wrapping the whole history every frame. NOTE: at the deepest possible scroll (Home, offset ===
// totalVisualRows - viewportRows) this bound degrades to the full transcript, same as the O(n)
// clamp — unavoidable without caching wrapped output, which is the one thing this file's own
// `wrapForTranscript` comment explains storing at write time can never safely do.
//
// Collected newest-line-first via `push` (O(1) amortized), each line's OWN rows kept in their
// normal top-to-bottom order — `.reverse()` at the end restores overall chronological order in one
// O(collected lines) pass. `unshift(...wrapped)` in this same loop was O(current
// tail length) per call, making the accumulation up to O(scroll-depth²): cheap while scrolled near
// the bottom, but the exact case a reader scrolled deep into a long session (or a fast streamed
// answer on a tall terminal) would actually hit every render.
//
// `pendingRows` has no production caller today — app.tsx always passes `[]` (see this file's own
// `wrapPendingRows` comment for why). When seeded (by this file's own pure-function tests, via
// `wrapPendingRows` above), it goes in FIRST, ahead of the backward walk over `entries` — not
// spread into a `[...entries, pending]` array at the call site (a prior version of this function
// did exactly that, tried and reverted): that allocated a full copy of the committed transcript on
// every call, for a function whose entire point is staying proportional to scroll depth instead of
// session length. Neither the parameter nor `wrapPendingRows` is deleted despite the dead call
// site — both stay valid, independently useful utilities their own tests still cover directly.
export function visibleTranscript(
  entries: TranscriptEntry[],
  rows: number,
  offset: number,
  columns: number,
  pendingRows: VisibleRow[] = [],
): VisibleRow[] {
  const collected: VisibleRow[][] = [];
  let collectedRows = 0;
  if (pendingRows.length > 0) {
    collected.push(pendingRows);
    collectedRows += pendingRows.length;
  }
  for (let i = entries.length - 1; i >= 0 && collectedRows < offset + rows; i--) {
    const entry = entries[i];
    const wrapped = wrapForTranscript(displayText(entry), columns).map((text) => ({
      role: entry.role,
      text,
    }));
    collected.push(wrapped);
    collectedRows += wrapped.length;
  }
  const tail = collected.reverse().flat();
  const end = Math.max(0, tail.length - offset);
  const start = Math.max(0, end - rows);
  return tail.slice(start, end);
}

// Every visible row's own render props for App.tsx's transcript viewport — factored out as a pure
// function, same reason `displayText` above is: a per-row `backgroundColor` is otherwise only
// checkable by rendering the whole tree, so a test can pin the actual prop this returns instead.
//
// The user-message band's own width is the widest currently visible role:"user" row (`stringWidth`,
// not `padEnd`: a CJK/wide-char row is fewer UTF-16 units than terminal cells, so `padEnd` would
// underpad it past the band's own edge). Every row `visibleTranscript` (above) returns is already
// wrapped to the terminal width, so this function only measures and pads relative to what's already
// there — it never needs to know the terminal width itself. A uniform band across all visible user
// rows (rather than padding each row to only its own width) is what makes it read as one band
// instead of a ragged per-message highlight — a deliberate design choice (docs/TUI-DESIGN.md's own
// note on `theme.userBg` as a confirmed, deliberate second use of background color), not a leftover
// of this being computed once for the whole array.
export function transcriptRowsProps(
  visibleRows: VisibleRow[],
): { text: string; backgroundColor: string | undefined }[] {
  const bandWidth = visibleRows.reduce(
    (widest, row) => (row.role === "user" ? Math.max(widest, stringWidth(row.text)) : widest),
    0,
  );
  return visibleRows.map((row) => {
    if (row.role !== "user") return { text: row.text, backgroundColor: undefined };
    const padding = " ".repeat(Math.max(0, bandWidth - stringWidth(row.text)));
    return { text: row.text + padding, backgroundColor: theme.userBg };
  });
}

// For a list-panel row rendered with `wrap="truncate-end"` (ConfigPanel, SetupPanel): that prop
// only guards a value wider than the panel — it does nothing for a literal newline, which Ink still
// renders as a real line break regardless of wrap mode. A non-secret config value can carry one:
// the TUI's own interactive entry steps strip `\r`/`\n` as they're typed (InputBox's own
// paste-terminator handling), but `seri config set` on the CLI (config/config.ts's setConfigValue)
// does not, so a value written that way can still reach a row's own render with one in it — and
// SetupPanel's own `maskValue` output (config/commands.ts) keeps a value's first/last 4 characters
// verbatim, so a newline in either survives the masking too. Collapsed to a single space, not
// stripped to nothing, so an oddly space-joined value at least stays legible about where the break
// was.
//
// `escapeControlChars` runs SECOND, on what's left after the collapse above (so it never touches
// the `\r`/`\n` this function already turned into spaces): the same unsanitized `seri config set`
// path that can carry a raw newline can carry any other control byte too, including ESC — an
// escape sequence in a config value would otherwise reach Ink's `<Text>` and write directly to the
// real terminal underneath the alt screen. `escapeControlChars` already exists for exactly this
// class of untrusted-content render (cli/output.ts's own comment on it).
export function singleLine(value: string): string {
  return escapeControlChars(value.replace(/\r\n|\r|\n/g, " "));
}

// The "clamp, don't re-center" rule shared by every list panel's window — factored out so
// useListWindow.ts's own `handleArrowKey` can call it instead of each panel reimplementing the
// sliding-window arithmetic.
export function slideWindow(offset: number, selected: number, windowSize: number): number {
  if (selected < offset) return selected;
  if (selected >= offset + windowSize) return selected - windowSize + 1;
  return offset;
}

// How many rows a list panel's own window can show for a terminal `rows` tall — clamped between
// `MIN_LIST_WINDOW` and `LIST_WINDOW_MAX`, never derived past either even on a very tall terminal.
export function listWindowSize(rows: number): number {
  return Math.min(LIST_WINDOW_MAX, Math.max(MIN_LIST_WINDOW, rows - PANEL_CHROME_ROWS));
}

// A list panel's own "+N more" footer count: rows strictly BELOW the window, not
// `total - visible.length`, which counts rows hidden ABOVE the window too and stays flat at
// `total - windowSize` for as long as the window is full — the footer would never count down while
// scrolling toward the bottom, and never disappear even once every remaining row was on screen.
export function remaining(total: number, offset: number, windowSize: number): number {
  return Math.max(0, total - offset - windowSize);
}

// Column widths for formatModelRow/MODEL_PICKER_HEADER below — plain padded strings, not a table
// component: this repo hand-rolls its TUI deliberately (App.tsx's own file-level comment) and Ink
// has none built in.
export const NAME_WIDTH = 22;
export const PROVIDER_WIDTH = 10;
export const CONTEXT_WIDTH = 7;
// Widest real value is "→ openrouter" (12 chars — the longest CATALOG_PROVIDERS name behind the
// reroute arrow) — 13 leaves one column of breathing room, matching this file's other columns'
// own generosity over their own widest realistic value.
export const ROUTE_WIDTH = 13;
// Cost was the table's last column before Route became the new trailing one — formatCost's own
// output is genuinely variable-width ("—" vs "$150.00/$600.00"), which was
// fine when nothing followed it, but Route now does, so this pads it too, or Route would drift
// out of its own column depending on how expensive a given row's model is. 18 covers the widest
// real pair in the bundled manifest (measured: $150.00/$600.00, 15 characters) with a little room
// to spare, not the exact minimum.
export const COST_WIDTH = 18;

// Hermes Agent's own 3-tier width breakpoints for the persistent mode-indicator row — reused as-is,
// not a new scheme.
export const MODE_LABEL_FULL_COLS = 76;
export const MODE_LABEL_COMPACT_COLS = 52;

// A non-TTY production stdout (piped/redirected output) genuinely has `columns === undefined`,
// and a real pty can separately report a genuine but unusable `columns === 0` for its first render
// or two — both are what `resolveWidth`'s `stdout.columns || DEFAULT_COLUMNS` (App.tsx) guards
// against; `||`, not `??`, is what makes the zero case fall back too. It is NOT what makes
// App.test.tsx's own component tests land in the full tier: `createTestRenderer`'s own default
// width (App.test.tsx's own `DEFAULT_WIDTH`, 100) is what does that, not this fallback.
export const DEFAULT_COLUMNS = 80;

// `resolveHeight`'s own fallback (App.tsx) — the same first-render `0` a pty can genuinely report
// for `columns` above, on the same ioctl-not-landed-yet timing, applies to row count too. The
// classic 80x24 pairing, not an arbitrary round number.
export const DEFAULT_ROWS = 24;

// Truncates with a trailing ellipsis (never mid-multi-byte-safe beyond what .slice already is —
// every field this feeds is plain ASCII: a model id/displayName/provider name) or pads with
// trailing spaces, so every row's later columns start at the same screen column regardless of an
// earlier one's actual length.
export function truncatePad(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

// Binary units (1024, not 1000): matches how a context window is actually described everywhere
// else this repo prints one (contextWindowSize's own comments, loop.ts) — 131,072 is "128K" this
// way, matching the task's own worked example, not "131K" a decimal K would give.
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1024 * 1024) return `${(tokens / (1024 * 1024)).toFixed(1)}M`;
  if (tokens >= 1024) return `${Math.round(tokens / 1024)}K`;
  return `${tokens}`;
}

// "—" (not "?"/"unknown"/blank) for the same reason printCost (cli/output.ts) writes out "unknown"
// rather than a bare "$": pricing.ts's own ModelCatalogEntry.pricing comment says `undefined` means
// models.dev never published a rate for this entry, not that it is free — an em dash reads as "no
// data" without implying either.
export function formatCost(pricing: ModelCatalogEntry["pricing"]): string {
  if (pricing === undefined) return "—";
  return `$${pricing.inputPerMTok.toFixed(2)}/$${pricing.outputPerMTok.toFixed(2)}`;
}

// The live status region's token count for the WHOLE turn so far, not just the currently-streaming
// model call — `reconcileUsage` (reducer.ts) is what sums a turn's several completed model calls
// onto this rather than replacing on each one; see its own comment for why. `reconciled*Tokens` is
// the sum of every completed call's real, known usage this turn, folded in field-by-field: a call
// whose `usage` reports only one of `inputTokens`/`outputTokens` still contributes the one it does
// report, rather than being discarded whole. `liveOutputEstimate` is ONLY the currently-streaming
// call's own running estimate, reset to 0 by EVERY reconciliation (whether this call's own
// `outputTokens` was real — folded into `reconciledOutputTokens` — or missing — moved onto
// `carriedOutputEstimate` instead of being left in place to collide with the NEXT call's own
// streaming estimate). `carriedOutputEstimate` is the running sum of every PAST call's own stranded
// output estimate — a call whose `outputTokens` never arrived leaves the only information ever
// obtained about its output sitting in `liveOutputEstimate` at the moment it reconciles; without
// moving it here first, the next call's `"text-delta"` accumulation would add its own growing
// estimate on top of that stranded one, and the following reconciliation would then reset the
// combined blob to 0 (or fold only the LATEST call's real `outputTokens` in), silently discarding
// the earlier call's estimate for good. The displayed output total is always
// `reconciledOutputTokens + carriedOutputEstimate + liveOutputEstimate`. `liveInputEstimate` is set
// ONCE per turn (`"turn-started"`, estimated from the current turn's own newly-submitted user text,
// not the full prompt/system/history) rather than accumulated incrementally — unlike output, the
// outgoing message is fully known upfront instead of streaming in — and resets to 0 the moment a
// real `usage.inputTokens` reconciles, mirroring `liveOutputEstimate`'s own reset; the displayed
// input total is always `reconciledInputTokens + liveInputEstimate`. `exact` says whether the MOST
// RECENT reconciliation was itself complete (both fields real) — it flips false the moment the next
// `text-delta` starts a fresh live estimate for whatever call runs next. `hasGap` is separate and
// STICKY for the whole turn: once any one call reconciles with only one (or neither) of its two
// fields real, that field's true value for THAT call is gone forever (no later call's own `usage`
// describes it), so the turn's aggregate must never claim full exactness again even after a later
// call reconciles completely — only `"turn-started"` resets it, for a genuinely fresh turn. The
// exactness `formatTokenProgress` actually displays is `exact && !hasGap`.
export type TokenProgress = {
  reconciledInputTokens: number;
  reconciledOutputTokens: number;
  liveInputEstimate: number;
  carriedOutputEstimate: number;
  liveOutputEstimate: number;
  exact: boolean;
  hasGap: boolean;
};

// TurnStatus's own elapsed-time display, matching formatContextWindow's plain-arithmetic style
// (no library). Never shows seconds once the elapsed time reaches an hour, matching this file's
// other coarsening choices (formatContextWindow drops sub-K precision past 1024) — a turn running
// that long doesn't need second-level precision.
export function formatElapsed(ms: number): string {
  // Clamped, not passed through: a negative `ms` (the system clock moving backward mid-session, or
  // any other unexpected negative delta) would otherwise render "-1s" or worse — every caller gets
  // "0s" instead of propagating a clock anomaly onto the screen.
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

// A streaming token-count estimate (vercel-labs/fx's heuristic): ~4 bytes per token, counted over
// non-whitespace content only. The byte length of the whitespace-stripped string equals the summed
// byte length of its whitespace-delimited spans (no multi-byte sequence straddles a stripped
// whitespace boundary), which is what makes this chunk-boundary-invariant — reducer.ts calls this
// once per streamed `text-delta` CHUNK and sums the results, and a word split across two chunks
// (e.g. "wor" + "ld") must total the same as the same word arriving whole. Deliberately returns a
// raw (un-rounded) number, rounded once only at display time (formatTokenProgress, below) —
// verified by this file's own chunk-boundary-invariance test.
export function estimateTokens(text: string): number {
  return Buffer.byteLength(text.replace(/\s+/g, ""), "utf8") / 4;
}

// `printUsage`'s exact "N in, M out" wording (cli/output.ts) for a reconciled count, `printCost`'s
// `~`-prefixed estimated convention (cli/output.ts) whenever `progress.exact` is false or
// `progress.hasGap` is set — see `TokenProgress`'s own comment for why both must hold before this
// ever drops the `~`. The output total sums three parts — reconciled, carried-over from a past
// call's own stranded estimate, and the currently-streaming call's own live estimate — see
// `TokenProgress`'s own comment for why those are kept separate rather than merged eagerly.
export function formatTokenProgress(progress: TokenProgress): string {
  const inTokens = Math.round(progress.reconciledInputTokens + progress.liveInputEstimate);
  const outTokens = Math.round(
    progress.reconciledOutputTokens + progress.carriedOutputEstimate + progress.liveOutputEstimate,
  );
  const exact = progress.exact && !progress.hasGap;
  return exact ? `${inTokens} in, ${outTokens} out` : `~${inTokens} in, ~${outTokens} out`;
}

// One row's worth of columns (name, provider, context, cost, route), space-joined — the picker's
// own selection marker ("> "/"  ") is prepended at the call site, not here, matching how the
// un-columned version already separated "which row is highlighted" from "what the row says".
// Factored out and exported specifically so column formatting is unit-testable without mounting
// Ink at all — this file had no pure formatting function of its own before the picker's columns
// needed one.
//
// The trailing Route column names whether THIS row's own provider has a
// key ("your key" — the same fact routing-priority resolution would act on). A row with no key of
// its own names the specific sibling provider it would actually reroute to ("→ openrouter"),
// rather than a bare "no key" plus an alternatives count that used to overstate reachability: the
// PROVIDER_WIDTH-adjacent `Provider` column already shows what "your key" belongs to, so repeating
// it there would be redundant, but a REROUTE target is a different provider than this row's own
// and is exactly the thing "no key" alone left the user to guess at. Only a row with no key AND no
// configured sibling reads as the true dead end, "no key" with nothing after it. The "+N route(s)"
// suffix survives only for a row that already works on its own (`keyConfigured`): once a no-key
// row names its reroute target directly, restating a raw sibling count next to it would double up
// on the same information, or — when none of those siblings has a key either — repeat the original
// bug of promising a fallback that does not exist.
// Extracted out of formatModelRow's own inline ternary so the picker's Route column and the
// persistent mode-indicator's route label (App.tsx's own JSX) share ONE vocabulary function —
// they can never independently drift on what "your key"/"→ provider"/"provided"/"no key" means
// for the same inputs. `gatewayReachable` is `true` only when `decideModelPickerOpen`/
// `formatModeLabel`'s caller passed a real plan-coverage predicate/route.
export function formatRouteLabel(input: {
  keyConfigured: boolean;
  rerouteTo?: ModelProvider;
  gatewayReachable?: boolean;
}): string {
  if (input.keyConfigured) return "your key";
  if (input.rerouteTo) return `→ ${input.rerouteTo}`;
  if (input.gatewayReachable) return "provided";
  return "no key";
}

// The persistent mode-indicator row's own content, factored out as a pure function for the same
// reason formatModelRow's own comment gives — unit-testable without mounting Ink. `route.rerouted`
// alone used to disambiguate "your key" from "→ provider", back when a gateway-served route was
// indistinguishable from a local one here — both have `rerouted: false`. `route.viaGateway` is
// what tells them apart now: `keyConfigured` is true only when NEITHER is set, and
// `gatewayReachable` is threaded through so a gateway-served route reads "provided" here exactly
// as it already does in the model picker's Route column.
// `route` can be undefined (found 2026-08-13, AppProps.route's own comment): runGuidedSetup mounts
// App before any provider key exists, so there is genuinely no route to show yet. Falls back to
// the bare mode indicator, same as the narrow-terminal branch below — showing a fabricated route
// would misreport "your key"/"→ provider" during the exact flow where neither is true.
// post-review fix: `route.model` is capped to NAME_WIDTH (the same width the picker table already
// truncates model names to) before it goes into the label — a real catalog id (a long OpenRouter
// id is well over 40 chars) was otherwise unbounded here, so it could push the row past the very
// terminal width MODE_LABEL_FULL_COLS/MODE_LABEL_COMPACT_COLS assumed it fit in.
export function formatModeLabel(
  modeIndicator: string,
  route: ResolvedRoute | undefined,
  width: number,
): string {
  if (route === undefined || width < MODE_LABEL_COMPACT_COLS) return modeIndicator;
  const modelName =
    route.model.length > NAME_WIDTH ? `${route.model.slice(0, NAME_WIDTH - 1)}…` : route.model;
  if (width < MODE_LABEL_FULL_COLS) return `${modeIndicator}  ${modelName}`;
  const routeLabel = formatRouteLabel({
    keyConfigured: !route.rerouted && !route.viaGateway,
    rerouteTo: route.rerouted ? route.provider : undefined,
    gatewayReachable: route.viaGateway,
  });
  return `${modeIndicator}  ${modelName} · ${routeLabel}`;
}

export function formatModelRow(row: ModelPickerEntry): string {
  const { entry, keyConfigured, alternatives, rerouteTo, gatewayReachable } = row;
  const route = formatRouteLabel({ keyConfigured, rerouteTo, gatewayReachable });
  const suffix =
    keyConfigured && alternatives > 0
      ? ` +${alternatives} route${alternatives === 1 ? "" : "s"}`
      : "";
  return (
    [
      truncatePad(entry.displayName, NAME_WIDTH),
      truncatePad(entry.provider, PROVIDER_WIDTH),
      formatContextWindow(entry.contextWindow).padStart(CONTEXT_WIDTH),
      truncatePad(formatCost(entry.pricing), COST_WIDTH),
      truncatePad(route, ROUTE_WIDTH),
    ].join(" ") + suffix
  );
}

// The picker's own column labels, same widths as formatModelRow's own columns — so the header sits
// flush above the rows it names regardless of terminal width.
export const MODEL_PICKER_HEADER = [
  truncatePad("Name", NAME_WIDTH),
  truncatePad("Provider", PROVIDER_WIDTH),
  "Context".padStart(CONTEXT_WIDTH),
  truncatePad("Cost", COST_WIDTH),
  truncatePad("Route", ROUTE_WIDTH),
].join(" ");

function priceLabel(entry: ModelCatalogEntry): string {
  if (entry.pricing === undefined) return "";
  return isZeroPriceEntry(entry) ? "free" : "paid";
}

// Multi-term AND-of-ORs, not a single unsplit substring check: the query is split on whitespace,
// and EVERY term must match at least one field (id, displayName, family, or provider),
// independently. A single-term query behaves exactly as before (id/displayName/family, now also
// provider); a multi-term one (e.g. "sonnet-5 anthropic") is what lets a query narrow to one
// specific ROUTE of a multi-route model rather than only ever narrowing by name. "free"/"paid"
// match via `priceLabel`, a synthesized haystack entry rather than a special-cased term: an entry
// with `pricing: undefined` (price genuinely unknown) yields `""`, which never `.includes()`s a
// non-empty term, so it matches neither "free" nor "paid" — the same "no data, not a claim either
// way" posture `formatCost` takes for the same entries. A model literally named "free"/"paid"
// still matches by name via the `displayName`/`id` haystacks, unaffected by `priceLabel`.
export function matchesFilter(row: ModelPickerEntry, query: string): boolean {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return true;
  const { entry } = row;
  const haystacks = [
    entry.id.toLowerCase(),
    entry.displayName.toLowerCase(),
    // `family` is a free-text field lifted verbatim from models.dev (ModelCatalogEntry's own
    // comment, packages/model-catalog/src/types.ts) — some upstream entries carry `null` there
    // rather than an empty string, so this cannot assume it is always safe to call
    // `.toLowerCase()` on directly.
    (entry.family ?? "").toLowerCase(),
    entry.provider.toLowerCase(),
    priceLabel(entry),
  ];
  return terms.every((term) => haystacks.some((haystack) => haystack.includes(term)));
}

// D8: the disabled-remove reason, verbatim — reused by the list row (grayed prompt) and would be
// reused again by any future surface that needs to explain the same fact, rather than the string
// being typed out at each call site and risking drift.
export function envShadowReason(keyName: string): string {
  return `set by $${keyName} in your environment — unset it in your shell`;
}

// One /setup list row's own text — masked value + source for a config/unset row, envShadowReason's
// own disabled-remove reason for an env row with nothing removable underneath it (which is more
// useful there than a masked value nobody can act on: the fix is in the shell, not in this
// panel).
//
// An env row is not always the non-removable case — `row.removable` (providerKeyState's own
// `hasConfigEntry`) is true when a
// config.json entry sits underneath the env var that's shadowing it, and pressing 'r'/Delete on
// that row genuinely removes it. `envShadowReason`'s "unset it in your shell" text used to render
// unconditionally for EVERY env row, telling a user with a real, removable entry that removal was
// impossible when it was not — commands.ts's own comment on `decideSetupOpen` already claimed
// "the panel states why, for the env case," which was false for exactly this state until now.
export function formatSetupRow(row: SetupProviderRow): string {
  const name = truncatePad(row.provider, PROVIDER_WIDTH);
  if (row.source === "unset") return `${name} not set`;
  // `singleLine`, not `row.masked` raw: `maskValue` keeps a value's first/last 4
  // characters verbatim, so a literal newline in either survives masking — see `singleLine`'s own
  // comment for how it reaches here. `?? ""`: `masked` is `undefined` only for the "unset" source
  // already returned above, never for "env"/"config" — the fallback is unreachable in practice, not
  // a real case being papered over.
  const masked = singleLine(row.masked ?? "");
  if (row.source === "env") {
    return row.removable
      ? `${name} ${masked} (env, config entry underneath — removable)`
      : `${name} ${envShadowReason(row.keyName)}`;
  }
  return `${name} ${masked} (config)`;
}
