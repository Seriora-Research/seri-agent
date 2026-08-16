// Pure formatting helpers for the TUI — zero Ink/React import, the same "testable without a
// terminal" property reducer.ts already has. Extracted out of App.tsx (Stage A,
// cli-commands-to-tui feature-plan.md) verbatim: a pure move, no behavior change.

import type { ModelCatalogEntry, ModelProvider } from "@seri/model-catalog";
import type { ResolvedRoute } from "../provider/routing";
import type { ModelPickerEntry, SetupProviderRow } from "./commands";

// The most a picker window ever shows at once, regardless of how many entries match the current
// filter — the catalog easily runs into the hundreds (models.dev's own OpenRouter listing), and
// rendering all of them would scroll the picker itself out of view, the same reasoning
// truncateArgsDisplay already applies to a single long line. `selectedIndex` can move past this
// many rows (arrow-key navigation over the full filtered list, not just what's on screen) — see
// `scrollOffset` (panels/ModelPicker.tsx) for how the visible window slides to keep it in view.
// Also `LIST_WINDOW_MAX` (below) — the hard cap every OTHER list panel's own `listWindowSize`
// clamps to, so none of them can render a taller window than the picker itself ever has.
export const MODEL_PICKER_WINDOW = 10;

// Shared by every list panel (ModelPicker, ConfigPanel, PermissionsPanel, SetupPanel) via
// useListWindow.ts. `LIST_WINDOW_MAX` is `MODEL_PICKER_WINDOW` itself, not a separately chosen
// number — under ink-testing-library, `Stdout` exposes `columns` but no `rows`, so a rows-derived
// window would fall through to the host terminal's own real size and make App.test.tsx's own
// row-count assertions machine-dependent; capping at the picker's own existing constant keeps
// every panel's window deterministic under that stub the same way the picker's already is.
// `MIN_LIST_WINDOW` is a floor for a short terminal, not a value any of today's real panels reach
// (SetupPanel's own 5 providers already fits under it) — enough rows that a floor-clamped panel
// still shows more than one entry at a time. `PANEL_CHROME_ROWS` is how much of a panel's own
// height is spent on its border, header/filter line, and "+N more" footer rather than list rows —
// measured against ConfigPanel/PermissionsPanel/SetupPanel's own JSX, the tallest of which
// (SetupPanel, list step) renders a border, a title line, and the footer around its rows.
export const MIN_LIST_WINDOW = 3;
export const LIST_WINDOW_MAX = MODEL_PICKER_WINDOW;
export const PANEL_CHROME_ROWS = 8;

// The transcript viewport's placeholder height for the one frame before useBoxMetrics has ever
// measured the live region below it (App.tsx) — not the real budget, just enough that the first
// frame renders a plausible slice of the transcript instead of an empty one.
export const FALLBACK_CHROME_ROWS = 6;

// The visible slice of a committed transcript for a viewport `rows` tall, `offset` lines up from
// the newest (0 = following the latest line). Tail-anchored, not head-anchored: a transcript
// longer than the viewport keeps showing its NEWEST lines by default, the same thing the terminal
// itself would show if these lines had just scrolled by normally.
export function visibleTranscript(lines: string[], rows: number, offset: number): string[] {
  const end = Math.max(0, lines.length - offset);
  const start = Math.max(0, end - rows);
  return lines.slice(start, end);
}

// The "clamp, don't re-center" rule lifted verbatim out of ModelPicker's own `moveSelection`
// (panels/ModelPicker.tsx) — factored out so useListWindow.ts can share it across every list panel
// instead of each reimplementing the picker's own sliding-window arithmetic.
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
// Cost was the table's last column before Route (D1/D2, feature-plan.md) became the new trailing
// one — formatCost's own output is genuinely variable-width ("—" vs "$150.00/$600.00"), which was
// fine when nothing followed it, but Route now does, so this pads it too, or Route would drift
// out of its own column depending on how expensive a given row's model is. 18 covers the widest
// real pair in the bundled manifest (measured: $150.00/$600.00, 15 characters) with a little room
// to spare, not the exact minimum.
export const COST_WIDTH = 18;

// D5 (byok-open3-route-indicator feature-plan.md): Hermes Agent's own 3-tier width breakpoints for
// the persistent mode-indicator row — reused as-is, per the plan's own D5, not a new scheme.
export const MODE_LABEL_FULL_COLS = 76;
export const MODE_LABEL_COMPACT_COLS = 52;

// A non-TTY production stdout (piped/redirected output) genuinely has `columns === undefined` —
// this is what `stdout.columns ?? DEFAULT_COLUMNS` (useTerminalWidth, App.tsx) guards against. It
// is NOT what makes App.test.tsx's own Ink component tests land in the full tier:
// ink-testing-library's stub stdout returns a real `columns: 100`, so those tests are already in
// the full tier on the actual value, not this fallback.
export const DEFAULT_COLUMNS = 80;

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

// One row's worth of columns (name, provider, context, cost, route), space-joined — the picker's
// own selection marker ("> "/"  ") is prepended at the call site, not here, matching how the
// un-columned version already separated "which row is highlighted" from "what the row says".
// Factored out and exported specifically so column formatting is unit-testable without mounting
// Ink at all — this file had no pure formatting function of its own before the picker's columns
// needed one.
//
// D1/D2 (feature-plan.md): the trailing Route column names whether THIS row's own provider has a
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
// D1 (byok-open3-route-indicator feature-plan.md): extracted out of formatModelRow's own inline
// ternary so the picker's Route column and the persistent mode-indicator's route label (App.tsx's
// own JSX) share ONE vocabulary function — they can never independently drift on what "your
// key"/"→ provider"/"provided"/"no key" means for the same inputs. `gatewayReachable` (D7) is the
// dead-code seam's own 4th state: always `false` in production today (decideModelPickerOpen's own
// `planCoverage` default), so "provided" is unreachable until a real data source exists.
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

// D2-D5 (byok-open3-route-indicator feature-plan.md): the persistent mode-indicator row's own
// content, factored out as a pure function for the same reason formatModelRow's own comment gives
// — unit-testable without mounting Ink. D4: `route.rerouted` alone disambiguates "your key" from
// "→ provider"; the "no key at all" branch of formatRouteLabel can never be reached from a live
// route, so `gatewayReachable` is never passed here.
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
    keyConfigured: !route.rerouted,
    rerouteTo: route.rerouted ? route.provider : undefined,
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

// Multi-term AND-of-ORs, not a single unsplit substring check: the query is split on whitespace,
// and EVERY term must match at least one field (id, displayName, family, or — new in this commit —
// provider), independently. A single-term query behaves exactly as before (id/displayName/family,
// now also provider); a multi-term one (e.g. "sonnet-5 anthropic") is what lets a query narrow to
// one specific ROUTE of a multi-route model rather than only ever narrowing by name.
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
  ];
  return terms.every((term) => haystacks.some((haystack) => haystack.includes(term)));
}

// D8: the disabled-remove reason, verbatim — reused by the list row (grayed prompt) and would be
// reused again by any future surface that needs to explain the same fact, rather than the string
// being typed out at each call site and risking drift.
export function envShadowReason(keyName: string): string {
  return `set by $${keyName} in your environment — unset it in your shell`;
}

// One /setup list row's own text — masked value + source for a config/unset row, D8's own
// disabled-remove reason for an env row with nothing removable underneath it (which is more
// useful there than a masked value nobody can act on: the fix is in the shell, not in this
// panel).
//
// Bug fixed here (code-review, PR #73, round 3, item #5): an env row is not always the
// non-removable case — `row.removable` (providerKeyState's own `hasConfigEntry`) is true when a
// config.json entry sits underneath the env var that's shadowing it, and pressing 'r'/Delete on
// that row genuinely removes it. `envShadowReason`'s "unset it in your shell" text used to render
// unconditionally for EVERY env row, telling a user with a real, removable entry that removal was
// impossible when it was not — commands.ts's own comment on `decideSetupOpen` already claimed
// "the panel states why, for the env case," which was false for exactly this state until now.
export function formatSetupRow(row: SetupProviderRow): string {
  const name = truncatePad(row.provider, PROVIDER_WIDTH);
  if (row.source === "unset") return `${name} not set`;
  if (row.source === "env") {
    return row.removable
      ? `${name} ${row.masked} (env, config entry underneath — removable)`
      : `${name} ${envShadowReason(row.keyName)}`;
  }
  return `${name} ${row.masked} (config)`;
}
