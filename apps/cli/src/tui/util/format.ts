// Pure formatting helpers for the TUI — zero Ink/React import, the same "testable without a
// terminal" property reducer.ts already has.

import { isZeroPriceEntry, type ModelCatalogEntry, type ModelProvider } from "@seri/model-catalog";
import { describeCodexSetupStatus } from "../../auth/codexBin";
import { escapeControlChars } from "../../cli/output";
import type { PermissionMode } from "../../gate/gate";
import type { LoopEvent } from "../../loop/loop";
import { type McpPanelRow, mcpStatusWord } from "../../mcp/commands";
import type { MemoryPanelRow } from "../../memory/commands";
import type { ResolvedRoute } from "../../provider/routing";
import type { ModelPickerEntry, SetupProviderRow } from "../state/commands";
import { ERROR_MARK, WARNING_MARK } from "../theme/theme";

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
// (SetupPanel's provider list already fits under it) — enough rows that a floor-clamped panel
// still shows more than one entry at a time. `PANEL_CHROME_ROWS` is how much of a panel's own
// height is spent on its border, header/filter line, and "+N more" footer rather than list rows —
// sized against ConfigPanel's own list step, the tallest of the four: unlike PermissionsPanel/
// SetupPanel, it can render a "+N more" footer AND a selectedDescription line at once (one row
// each), on top of the border/header/hint every panel already has.
export const LIST_WINDOW_MAX = 10;
export const MIN_LIST_WINDOW = 3;
export const PANEL_CHROME_ROWS = 9;

// Every row a panel's own budget has to share with the rest of App.tsx's render, reserved
// unconditionally rather than threaded through as props: the unconditional mode-indicator row and
// a `commandError` line (one row, shown above the panel) — 1 + 1 = 2. Unconditional because
// `commandError` lives on reducer state inside App, out of scope for the four panel components
// that call `useListWindow(rows, selected)` with nothing else in scope — threading that flag into
// every one of them (plus App itself) costs far more than the alternative: over-reserving this
// one extra row when no command-error is showing costs at most one list row on a 24-row terminal
// and nothing at all on a 25+ row one, while under-reserving pushes a panel row off the alt
// screen with no scrollback to recover it.
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
export const APP_CHROME_ROWS = 2;

// Rows reserved from the terminal height for everything OTHER than the transcript scrollbox
// (app.tsx: `rows - FALLBACK_CHROME_ROWS`), for the one frame before `onSizeChange` has ever
// measured the scrollbox's own wrapping box — not a real chrome-row count, just enough that the
// first frame renders a plausible transcript height instead of a 0-height scrollbox.
export const FALLBACK_CHROME_ROWS = 6;

export type TranscriptRole = "user" | "assistant" | "system";
export type TranscriptEntry = {
  role: TranscriptRole;
  text: string;
  muted?: boolean;
  markdown?: boolean;
};

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

// The three `PermissionMode` label strings the persistent mode-indicator row renders — Claude
// Code's own `<what it does> on` shape, not the raw union value. `⏸` prefixes the two modes that
// don't let a write tool through unconditionally (`read-only` blocks it outright, `approve-each`
// pauses for a prompt — `gate/gate.ts`'s own `checkPermission`); `⏵⏵` the one that does — the same
// convention CC uses for identical semantics. `auto` deliberately reads "bypass permissions", not
// "auto": seri's `auto` mode short-circuits every permission check to allow (gate/gate.ts), which
// is CC's own `bypassPermissions`, not CC's classifier-reviewed `auto`.
export const MODE_LABEL = {
  "read-only": "⏸ read-only mode on",
  "approve-each": "⏸ approve-each mode on",
  auto: "⏵⏵ bypass permissions on",
} satisfies Record<PermissionMode, string>;

// Persistent (shown on every render, not just right after a cycle) — a transient hint would not
// help a user who has never pressed the key yet.
export const MODE_CYCLE_HINT = " (shift+tab to cycle)";

// The persistent mode-indicator row still floors the cycle hint at `MODE_HINT_COLS` (app.tsx
// via `modeRowHintVisible`). Model, route, and effort are leftover-packed by `formatModeDetail`
// into whatever columns remain after the indicator — longest suffix that fits, then the next
// shorter, then empty. Sized against the longest label, "⏵⏵ bypass permissions on" (26 cols,
// worst case its glyph renders double-width) + the hint (21 cols) = 47, still under 52, so the
// hint floor holds even in that worst case when detail is empty. This proof does not (and cannot)
// account for the mode row's own right-hand content (the scroll banner / `state.status`) sharing
// the same row — see app.tsx's own `showRightSide` for how that side of the row is kept from
// wrapping instead.
export const MODE_HINT_COLS = 52;
// formatModeDetail's display cap for the `/effort` tier suffix — a tier value ultimately comes
// from models.dev, an external and unvalidated source, so this is a display budget, not a bound
// on the data. The widest values referenced anywhere in this codebase's own provider tables today
// are "minimal" and "default" (7 chars each — provider/reasoning.ts's own comment on OpenAI's and
// groq's effort unions); one column of breathing room over that, matching ROUTE_WIDTH's own
// convention above (13 for a 12-char worst case) rather than COST_WIDTH's wider 3-column margin.
export const EFFORT_WIDTH = 8;

export const INPUT_PLACEHOLDER = "describe a task · / for commands · @ for files";

// A non-TTY production stdout (piped/redirected output) genuinely has `columns === undefined`,
// and a real pty can separately report a genuine but unusable `columns === 0` for its first render
// or two — both are what `resolveWidth`'s `stdout.columns || DEFAULT_COLUMNS` (App.tsx) guards
// against; `||`, not `??`, is what makes the zero case fall back too. It is NOT what makes
// App.test.tsx's own component tests leftover-pack the full model+route suffix:
// `createTestRenderer`'s own default width (App.test.tsx's own `DEFAULT_WIDTH`, 100) is what does
// that, not this fallback.
export const DEFAULT_COLUMNS = 80;

// `resolveHeight`'s own fallback (App.tsx) — the same first-render `0` a pty can genuinely report
// for `columns` above, on the same ioctl-not-landed-yet timing, applies to row count too. The
// classic 80x24 pairing, not an arbitrary round number.
export const DEFAULT_ROWS = 24;

// Truncates with a trailing ellipsis (never mid-multi-byte-safe beyond what .slice already is —
// every field this feeds is plain ASCII: a model id/displayName/provider name/effort tier).
function truncate(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

// truncate(), then pads with trailing spaces, so every row's later columns start at the same
// screen column regardless of an earlier one's actual length.
export function truncatePad(text: string, width: number): string {
  return truncate(text, width).padEnd(width);
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

// TUI-only fragment shared by live TurnStatus and the settled done line. Input is ↑, output is ↓
// (the same glyphs the TUI already uses for list navigation). `printUsage` on the non-interactive
// path keeps "N in, M out" — this helper does not feed that line. `printCost`'s `~` convention
// still applies whenever `progress.exact` is false or `progress.hasGap` is set — see
// `TokenProgress`'s own comment for why both must hold before this ever drops the `~`, and why
// it prefixes BOTH numbers together. The output total sums three parts — reconciled, carried-over
// from a past call's own stranded estimate, and the currently-streaming call's own live estimate.
export function formatTokenProgress(progress: TokenProgress): string {
  const inTokens = Math.round(progress.reconciledInputTokens + progress.liveInputEstimate);
  const outTokens = Math.round(
    progress.reconciledOutputTokens + progress.carriedOutputEstimate + progress.liveOutputEstimate,
  );
  const exact = progress.exact && !progress.hasGap;
  return exact ? `${inTokens} ↑, ${outTokens} ↓` : `~${inTokens} ↑, ~${outTokens} ↓`;
}

export function formatDoneLine(
  reason: Extract<LoopEvent, { type: "done" }>["reason"],
  tokens?: TokenProgress,
): string {
  let head: string;
  switch (reason) {
    case "no-tool-call":
      head = "done";
      break;
    case "aborted":
    case "max-iterations":
    case "repeated-denials":
      head = `done: ${reason}`;
      break;
    default: {
      const _unhandled: never = reason;
      return _unhandled;
    }
  }
  return tokens === undefined ? head : `${head} · ${formatTokenProgress(tokens)}`;
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
// they can never independently drift on what "your key"/"plan"/"→ provider"/"provided"/"no key"
// means for the same inputs. `gatewayReachable` is `true` only when `decideModelPickerOpen`/
// `formatModeDetail`'s caller passed a real plan-coverage predicate/route. `subscriptionCovered`
// is the ChatGPT-plan overlay, not an API key, and wins over keyConfigured so a plan-plus-key
// row still reads as included.
export function formatRouteLabel(input: {
  keyConfigured: boolean;
  rerouteTo?: ModelProvider;
  gatewayReachable?: boolean;
  subscriptionCovered?: boolean;
}): string {
  if (input.subscriptionCovered) return "plan";
  if (input.keyConfigured) return "your key";
  if (input.rerouteTo) return `→ ${input.rerouteTo}`;
  if (input.gatewayReachable) return "provided";
  return "no key";
}

// The persistent mode-indicator row's own model/route suffix, factored out as a pure function for
// the same reason formatModelRow's own comment gives — unit-testable without mounting Ink.
// `route.rerouted` alone used to disambiguate "your key" from "→ provider", back when a
// gateway-served route was indistinguishable from a local one here — both have `rerouted: false`.
// `route.credential` is what tells them apart now: `keyConfigured` is true only for a
// non-rerouted `key` credential, `subscriptionCovered` for `subscription`, and `gatewayReachable`
// for `gateway` — so a ChatGPT-plan route reads "plan" here exactly as it already does in the
// model picker's Route column.
// `route` can be undefined (found 2026-08-13, AppProps.route's own comment): runGuidedSetup mounts
// App before any provider key exists, so there is genuinely no route to show yet. Falls back to no
// suffix — showing a fabricated route would misreport "your key"/"→ provider" during the exact
// flow where neither is true.
// `width` is the leftover budget for this suffix only: the caller has already subtracted the
// indicator and any right-side banner/status. Hint visibility is applied by the caller
// (`modeRowHintVisible`), not here, so the suffix claims space first. Greedy drop order:
// model+route+effort, then model+route, then model, then empty. `route.model` is capped to
// NAME_WIDTH (the same width the picker table already truncates model names to) before it goes
// into the return — a real catalog id (a long OpenRouter id is well over 40 chars) was otherwise
// unbounded here and could overflow the leftover. Carries its own leading two spaces (mirroring
// the old inline `"  "` join) and is `""` when there is nothing to show, so app.tsx's JSX never
// has to add spacing of its own — it renders this directly next to the mode indicator, which
// app.tsx already has in hand and colors separately.
// `effortTier` is the active `/effort` override (or `undefined` for none/auto/stale — see its
// caller in app.tsx), packed with the route when leftover allows. Truncated with the same
// defensive shape as the model name, since a tier value ultimately comes from models.dev, an
// external and unvalidated source.
export function formatModeDetail(
  route: ResolvedRoute | undefined,
  width: number,
  effortTier: string | undefined,
): string {
  if (route === undefined) return "";
  const model = `  ${truncate(route.model, NAME_WIDTH)}`;
  const routeLabel = formatRouteLabel({
    keyConfigured: !route.rerouted && route.credential === "key",
    subscriptionCovered: !route.rerouted && route.credential === "subscription",
    rerouteTo: route.rerouted ? route.provider : undefined,
    gatewayReachable: route.credential === "gateway",
  });
  const withRoute = `${model} · ${routeLabel}`;
  const withEffort =
    effortTier === undefined ? withRoute : `${withRoute} · ${truncate(effortTier, EFFORT_WIDTH)}`;
  if (withEffort.length <= width) return withEffort;
  if (withRoute.length <= width) return withRoute;
  if (model.length <= width) return model;
  return "";
}

// Whether the persistent mode row still has room for MODE_CYCLE_HINT after leftover-packing the
// detail suffix. Floors at MODE_HINT_COLS even when the hint itself would fit in a narrower row;
// yields whenever indicator + hint + already-packed detail would overflow `remaining`.
export function modeRowHintVisible(
  remaining: number,
  indicatorWidth: number,
  detailLength: number,
): boolean {
  return (
    remaining >= MODE_HINT_COLS &&
    indicatorWidth + MODE_CYCLE_HINT.length + detailLength <= remaining
  );
}

// Inside FRAME (single border 1+1, PAD_X 1+1) the ListRow marker ("> "/"  ", 2 cols) leaves this
// many columns for the label. Numeric, not imported PAD_X: spacing.ts type-imports this file.
export const PICKER_LABEL_CHROME = 6;

export function pickerLabelWidth(terminalCols: number): number {
  return Math.max(0, (terminalCols || DEFAULT_COLUMNS) - PICKER_LABEL_CHROME);
}

// Optional `labelWidth` is the columns ListRow has for this string (pickerLabelWidth). Omitted
// returns the full five columns plus suffix. When the full string overflows, drop the suffix
// first; if still over, drop the Route column. Context and Cost stay.
export function formatModelRow(row: ModelPickerEntry, labelWidth?: number): string {
  const { entry, keyConfigured, alternatives, rerouteTo, gatewayReachable, subscriptionCovered } =
    row;
  const route = formatRouteLabel({
    keyConfigured,
    rerouteTo,
    gatewayReachable,
    subscriptionCovered,
  });
  const suffix =
    keyConfigured && alternatives > 0
      ? ` +${alternatives} route${alternatives === 1 ? "" : "s"}`
      : "";
  const columns = [
    truncatePad(entry.displayName, NAME_WIDTH),
    truncatePad(entry.provider, PROVIDER_WIDTH),
    formatContextWindow(entry.contextWindow).padStart(CONTEXT_WIDTH),
    truncatePad(subscriptionCovered ? "included" : formatCost(entry.pricing), COST_WIDTH),
    truncatePad(route, ROUTE_WIDTH),
  ];
  const full = columns.join(" ") + suffix;
  if (labelWidth === undefined || full.length <= labelWidth) return full;
  const withoutSuffix = columns.join(" ");
  if (withoutSuffix.length <= labelWidth) return withoutSuffix;
  return columns.slice(0, 4).join(" ");
}

// Same five header cells as the unbounded MODEL_PICKER_HEADER. Omitted width, or a width the
// five-column string already fits, keeps Route; otherwise drop Route in lockstep with formatModelRow.
export function formatModelPickerHeader(labelWidth?: number): string {
  const columns = [
    truncatePad("Name", NAME_WIDTH),
    truncatePad("Provider", PROVIDER_WIDTH),
    "Context".padStart(CONTEXT_WIDTH),
    truncatePad("Cost", COST_WIDTH),
    truncatePad("Route", ROUTE_WIDTH),
  ];
  const full = columns.join(" ");
  if (labelWidth === undefined || full.length <= labelWidth) return full;
  return columns.slice(0, 4).join(" ");
}

export const MODEL_PICKER_HEADER = formatModelPickerHeader();

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
  const { entry, subscriptionCovered } = row;
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
    ...(subscriptionCovered ? ["included", "plan"] : []),
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
  if (row.kind === "heading") return row.label;
  if (row.kind === "subscription") {
    if (row.provider === "xai") {
      const name = truncatePad("grok", PROVIDER_WIDTH);
      return row.connected ? `${name} connected` : `${name} not connected`;
    }
    return `${truncatePad("codex", PROVIDER_WIDTH)} ${describeCodexSetupStatus(row.status)}`;
  }
  const name = truncatePad(row.provider, PROVIDER_WIDTH);
  if (row.source === "unset") return `${name} not set`;
  const masked = singleLine(row.masked ?? "");
  if (row.unusedBecause !== undefined) {
    return `${name} ${masked} (${row.source}, ${row.unusedBecause})`;
  }
  if (row.source === "env") {
    return row.removable
      ? `${name} ${masked} (env, config entry underneath — removable)`
      : `${name} ${envShadowReason(row.keyName)}`;
  }
  return `${name} ${masked} (config)`;
}

// One row of the /skills panel. Produced by skillsPanelRows (skills/commands.ts) from the session's
// own registry, so it carries only this project's skills and this profile's global ones — never
// another project's, which the discovery walk cannot reach in the first place.
export type SkillsPanelRow = {
  name: string;
  description: string;
  scope: "project" | "global";
  /** Worktree-relative for a project skill, absolute for a global one — whichever names the file
   *  more usefully to someone about to open it. */
  where: string;
  author: "human" | "archivist";
  modelInvocable: boolean;
};

// Same padded-string approach the model picker's own columns use, and the same reason: this repo
// hand-rolls its TUI and has no table component.
export const SKILL_NAME_WIDTH = 24;
export const SKILL_SCOPE_WIDTH = 9;

export function formatSkillRow(row: SkillsPanelRow): string {
  // The marks are what a reader cannot get from the name or the path: who wrote it, and whether
  // the model may reach for it on its own. Omitted entirely when neither applies, so the common
  // row stays quiet.
  const marks = [
    row.author === "archivist" ? "archivist" : undefined,
    row.modelInvocable ? undefined : "user-only",
  ].filter(Boolean);
  const suffix = marks.length === 0 ? "" : `  [${marks.join(", ")}]`;
  return `${truncatePad(row.name, SKILL_NAME_WIDTH)}${truncatePad(row.scope, SKILL_SCOPE_WIDTH)}${row.where}${suffix}`;
}

export const SKILLS_PANEL_HEADER = `${"NAME".padEnd(SKILL_NAME_WIDTH)}${"SCOPE".padEnd(SKILL_SCOPE_WIDTH)}FILE`;

export function matchesSkillFilter(row: SkillsPanelRow, query: string): boolean {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return true;
  const haystacks = [
    row.name.toLowerCase(),
    row.description.toLowerCase(),
    row.where.toLowerCase(),
  ];
  return terms.every((term) => haystacks.some((hay) => hay.includes(term)));
}

// One row of the /mcp panel (mcpPanelRows, mcp/commands.ts) — either a scope header or a server.
// No column padding, unlike formatSkillRow: a header's "(<file path>)" and a server's status word
// vary too widely in length for fixed columns to buy anything, and the design mock
// (docs/specs/020-extensibility/research-mcp.md §7) already reads as free text, not a table.
// `WARNING_MARK`/`ERROR_MARK` are the mark-not-color substitution docs/design/tui.md requires —
// mcpStatusWord itself (mcp/commands.ts) deliberately returns a plain word with no glyph, precisely
// so this is the one place that decides which status gets one.
export function formatMcpRow(row: McpPanelRow): string {
  if (row.kind === "header") {
    const label = row.scope === "project" ? "Project" : "User";
    return `${label} (${row.sourceFile})`;
  }
  const mark =
    row.status.state === "needs-auth"
      ? WARNING_MARK
      : row.status.state === "failed"
        ? ERROR_MARK
        : "";
  const toolsPart =
    row.toolCount === undefined ? "" : ` · ${row.toolCount} tool${row.toolCount === 1 ? "" : "s"}`;
  return `${row.name} · ${mark}${mcpStatusWord(row.status)}${toolsPart}`;
}

// Column padding, unlike formatMcpRow: an action is one of three short words and a file one of
// three fixed shapes, so the columns line up for free and a reader scans down "what kind of write"
// and "which file" instead of re-parsing each row. Same padded-string approach formatSkillRow uses,
// and the same reason: this repo hand-rolls its TUI and has no table component.
export const MEMORY_ACTION_WIDTH = 8;
export const MEMORY_FILE_WIDTH = 22;

export const MEMORY_PANEL_HEADER = `${"ACTION".padEnd(MEMORY_ACTION_WIDTH)}${"FILE".padEnd(MEMORY_FILE_WIDTH)}WRITE`;

// `singleLine` for McpTrustPreview's own reason: `detail` is the model's own proposed memory text,
// free to contain literal newlines, and OpenTUI renders each break as a real row — one such write
// would push the rest of the list past the viewport. Collapse first, then let the row's own
// `truncate` clip what is left to one row.
export function formatMemoryRow(row: MemoryPanelRow): string {
  // `[transient]` is the one mark a reader cannot get from the other three columns: the model
  // tagged this write as session-scoped noise rather than a lasting fact (memory/store.ts's own
  // `durable` comment), which is the single strongest reason to reject it. Nothing is printed for
  // the durable case, so the ordinary row stays quiet.
  const mark = row.durable ? "" : "  [transient]";
  return `${truncatePad(row.action, MEMORY_ACTION_WIDTH)}${truncatePad(row.file, MEMORY_FILE_WIDTH)}${singleLine(row.detail)}${mark}`;
}

// The welcome splash's `directory` row (routes/setup/SplashBanner.tsx). `home` is a parameter, not
// read from `node:os` here, so this stays a pure function testable on any OS — a Windows home and
// a POSIX one are both just strings to it. Separator-agnostic for the same reason: the character
// after the home prefix is read off the input rather than compared against `node:path`'s `sep`,
// which would be the wrong one for every test not running on the path's own platform. A `path` that
// merely starts with the home STRING but continues into another segment ("/home/lion-old") is left
// alone, which is why the separator check exists at all.
export function formatHomePath(path: string, home: string): string {
  if (home.length === 0 || !path.startsWith(home)) return path;
  const rest = path.slice(home.length);
  if (rest.length === 0) return "~";
  if (rest[0] !== "/" && rest[0] !== "\\") return path;
  return `~${rest}`;
}
