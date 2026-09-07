import { isZeroPriceEntry, type ModelCatalogEntry, type ModelProvider } from "@seri/model-catalog";
import { describeCodexSetupStatus } from "../../auth/codexBin";
import { describeSeriSetupStatus } from "../../auth/seriIgnore";
import { escapeControlChars } from "../../cli/output";
import type { PermissionMode } from "../../gate/gate";
import type { LoopEvent } from "../../loop/loop";
import { type McpPanelRow, mcpStatusWord } from "../../mcp/commands";
import type { MemoryPanelRow } from "../../memory/commands";
import type { ResolvedRoute } from "../../provider/routing";
import type { ModelPickerEntry, SetupProviderRow } from "../state/commands";
import type { FileChangeView } from "../../fileChange";
import { ERROR_MARK, theme, WARNING_MARK } from "../theme/theme";

export const LIST_WINDOW_MAX = 10;
export const MIN_LIST_WINDOW = 3;
export const PANEL_CHROME_ROWS = 8;

export const APP_CHROME_ROWS = 2;

export const FALLBACK_CHROME_ROWS = 6;

export type TranscriptRole = "user" | "assistant" | "system";
export type TranscriptEntry = {
  role: TranscriptRole;
  text: string;
  muted?: boolean;
  markdown?: boolean;
  kind?: "reasoning" | "quota-exhausted" | "file-change" | "tool-summary";
  body?: string;
  expanded?: boolean;
  elapsedMs?: number;
  fileChange?: FileChangeView;
};

export type TranscriptKind = NonNullable<TranscriptEntry["kind"]>;

export const REASONING_MARK_CLOSED = "▸";
export const REASONING_MARK_OPEN = "▾";

export function systemEntryFg(entry: TranscriptEntry): string {
  if (entry.kind === "quota-exhausted") return theme.quotaExhausted;
  return entry.muted ? theme.muted : theme.text;
}

export function formatReasoningCaret(expanded: boolean, elapsedMs: number): string {
  const mark = expanded ? REASONING_MARK_OPEN : REASONING_MARK_CLOSED;
  return `${mark} thought · ${formatElapsed(elapsedMs)}`;
}

export function formatLiveThinkingStatus(
  expanded: boolean,
  elapsed: string,
  tokens: string,
): string {
  const mark = expanded ? REASONING_MARK_OPEN : REASONING_MARK_CLOSED;
  return `${mark} thinking · ${elapsed} · ${tokens}`;
}

export function singleLine(value: string): string {
  return escapeControlChars(value.replace(/\r\n|\r|\n/g, " "));
}

export function slideWindow(offset: number, selected: number, windowSize: number): number {
  if (selected < offset) return selected;
  if (selected >= offset + windowSize) return selected - windowSize + 1;
  return offset;
}

export function listWindowSize(rows: number): number {
  return Math.min(LIST_WINDOW_MAX, Math.max(MIN_LIST_WINDOW, rows - PANEL_CHROME_ROWS));
}

export function remaining(total: number, offset: number, windowSize: number): number {
  return Math.max(0, total - offset - windowSize);
}

export const NAME_WIDTH = 22;
export const PROVIDER_WIDTH = 10;
export const CONTEXT_WIDTH = 7;
export const ROUTE_WIDTH = 13;
export const COST_WIDTH = 18;

export const MODE_LABEL = {
  "read-only": "⏸ read-only mode on",
  "approve-each": "⏸ approve-each mode on",
  auto: "⏵⏵ bypass permissions on",
} satisfies Record<PermissionMode, string>;

export const PLAN_MODE_LABEL = "⏸ plan mode on";

export const MODE_CYCLE_HINT = " (shift+tab to cycle)";
export const PLAN_MODE_LEAVE_HINT = " (ctrl+o to leave)";

export const MODE_HINT_COLS = 52;
export const EFFORT_WIDTH = 8;

export const INPUT_PLACEHOLDER = "describe a task · / for commands · ! shell · @ for files";

export const DEFAULT_COLUMNS = 80;

export const DEFAULT_ROWS = 24;

function truncate(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

export function truncatePad(text: string, width: number): string {
  return truncate(text, width).padEnd(width);
}

export function formatContextWindow(tokens: number): string {
  if (tokens >= 1024 * 1024) return `${(tokens / (1024 * 1024)).toFixed(1)}M`;
  if (tokens >= 1024) return `${Math.round(tokens / 1024)}K`;
  return `${tokens}`;
}

export function formatCost(pricing: ModelCatalogEntry["pricing"]): string {
  if (pricing === undefined) return "—";
  return `$${pricing.inputPerMTok.toFixed(2)}/$${pricing.outputPerMTok.toFixed(2)}`;
}

export type TokenProgress = {
  reconciledInputTokens: number;
  reconciledOutputTokens: number;
  liveInputEstimate: number;
  carriedOutputEstimate: number;
  liveOutputEstimate: number;
  exact: boolean;
  hasGap: boolean;
};

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

export function estimateTokens(text: string): number {
  return Buffer.byteLength(text.replace(/\s+/g, ""), "utf8") / 4;
}

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
    case "plan-submitted":
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

function subscriptionRouteLabel(provider?: ModelProvider): string {
  if (provider === "xai") return "grok";
  if (provider === "openai") return "chatgpt";
  return "plan";
}

export function formatRouteLabel(input: {
  keyConfigured: boolean;
  rerouteTo?: ModelProvider;
  gatewayReachable?: boolean;
  subscriptionCovered?: boolean;
  provider?: ModelProvider;
}): string {
  if (input.subscriptionCovered) return subscriptionRouteLabel(input.provider);
  if (input.keyConfigured && !input.gatewayReachable) {
    return input.provider ?? "your key";
  }
  if (input.rerouteTo) return `→ ${input.rerouteTo}`;
  if (input.gatewayReachable) return "seri";
  return "no key";
}

export function formatRouteLabelFromResolved(route: ResolvedRoute): string {
  return formatRouteLabel({
    keyConfigured: !route.rerouted && route.credential === "key",
    subscriptionCovered: !route.rerouted && route.credential === "subscription",
    rerouteTo: route.rerouted ? route.provider : undefined,
    gatewayReachable: route.credential === "gateway",
    provider: route.provider,
  });
}

export function formatModeDetail(
  route: ResolvedRoute | undefined,
  width: number,
  effortTier: string | undefined,
): string {
  if (route === undefined) return "";
  const model = `  ${truncate(route.model, NAME_WIDTH)}`;
  const routeLabel = formatRouteLabelFromResolved(route);
  const withRoute = `${model} · ${routeLabel}`;
  const withEffort =
    effortTier === undefined ? withRoute : `${withRoute} · ${truncate(effortTier, EFFORT_WIDTH)}`;
  if (withEffort.length <= width) return withEffort;
  if (withRoute.length <= width) return withRoute;
  if (model.length <= width) return model;
  return "";
}

export function modeRowHintVisible(
  remaining: number,
  indicatorWidth: number,
  detailLength: number,
  hintLength: number,
): boolean {
  return remaining >= MODE_HINT_COLS && indicatorWidth + hintLength + detailLength <= remaining;
}

export const PICKER_LABEL_CHROME = 6;

export function pickerLabelWidth(terminalCols: number): number {
  return Math.max(0, (terminalCols || DEFAULT_COLUMNS) - PICKER_LABEL_CHROME);
}

export function formatModelRow(row: ModelPickerEntry, labelWidth?: number): string {
  const { entry, keyConfigured, alternatives, rerouteTo, gatewayReachable, subscriptionCovered } =
    row;
  const route = formatRouteLabel({
    keyConfigured,
    rerouteTo,
    gatewayReachable,
    subscriptionCovered,
    provider: entry.provider,
  });
  const suffix =
    keyConfigured && alternatives > 0
      ? ` +${alternatives} route${alternatives === 1 ? "" : "s"}`
      : "";
  const columns = [
    truncatePad(entry.displayName, NAME_WIDTH),
    formatContextWindow(entry.contextWindow).padStart(CONTEXT_WIDTH),
    truncatePad(subscriptionCovered ? "included" : formatCost(entry.pricing), COST_WIDTH),
    truncatePad(route, ROUTE_WIDTH),
  ];
  const full = columns.join(" ") + suffix;
  if (labelWidth === undefined || full.length <= labelWidth) return full;
  const withoutSuffix = columns.join(" ");
  if (withoutSuffix.length <= labelWidth) return withoutSuffix;
  return columns.slice(0, 3).join(" ");
}

export function formatModelPickerHeader(labelWidth?: number): string {
  const columns = [
    truncatePad("Name", NAME_WIDTH),
    "Context".padStart(CONTEXT_WIDTH),
    truncatePad("Cost", COST_WIDTH),
    truncatePad("Route", ROUTE_WIDTH),
  ];
  const full = columns.join(" ");
  if (labelWidth === undefined || full.length <= labelWidth) return full;
  return columns.slice(0, 3).join(" ");
}

export const MODEL_PICKER_HEADER = formatModelPickerHeader();

function priceLabel(entry: ModelCatalogEntry): string {
  if (entry.pricing === undefined) return "";
  return isZeroPriceEntry(entry) ? "free" : "paid";
}

export function matchesFilter(row: ModelPickerEntry, query: string): boolean {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return true;
  const { entry, subscriptionCovered, gatewayReachable, keyConfigured, rerouteTo } = row;
  const routeLabel = formatRouteLabel({
    keyConfigured,
    rerouteTo,
    gatewayReachable,
    subscriptionCovered,
    provider: entry.provider,
  });
  const haystacks = [
    entry.id.toLowerCase(),
    entry.displayName.toLowerCase(),
    (entry.family ?? "").toLowerCase(),
    ...(routeLabel === "seri" ? [] : [entry.provider.toLowerCase()]),
    routeLabel.toLowerCase(),
    priceLabel(entry),
    ...(subscriptionCovered ? ["included", "plan", subscriptionRouteLabel(entry.provider)] : []),
    ...(gatewayReachable ? ["seri", "plan"] : []),
  ];
  return terms.every((term) => haystacks.some((haystack) => haystack.includes(term)));
}

export function envShadowReason(keyName: string): string {
  return `set by $${keyName} in your environment — unset it in your shell`;
}

export function formatSetupRow(row: SetupProviderRow): string {
  if (row.kind === "heading") return row.label;
  if (row.kind === "subscription") {
    if (row.provider === "xai") {
      const name = truncatePad("grok", PROVIDER_WIDTH);
      return row.connected ? `${name} connected` : `${name} not connected`;
    }
    if (row.provider === "seri") {
      return `${truncatePad("seri", PROVIDER_WIDTH)} ${describeSeriSetupStatus(row.status)}`;
    }
    return `${truncatePad("chatgpt", PROVIDER_WIDTH)} ${describeCodexSetupStatus(row.status)}`;
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

export const SKILL_NAME_WIDTH = 24;
export const SKILL_SCOPE_WIDTH = 9;

export function formatSkillRow(row: SkillsPanelRow): string {
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

export const MEMORY_ACTION_WIDTH = 8;
export const MEMORY_FILE_WIDTH = 22;

export const MEMORY_PANEL_HEADER = `${"ACTION".padEnd(MEMORY_ACTION_WIDTH)}${"FILE".padEnd(MEMORY_FILE_WIDTH)}WRITE`;

export function formatMemoryRow(row: MemoryPanelRow): string {
  const mark = row.durable ? "" : "  [transient]";
  return `${truncatePad(row.action, MEMORY_ACTION_WIDTH)}${truncatePad(row.file, MEMORY_FILE_WIDTH)}${singleLine(row.detail)}${mark}`;
}

export function formatHomePath(path: string, home: string): string {
  if (home.length === 0 || !path.startsWith(home)) return path;
  const rest = path.slice(home.length);
  if (rest.length === 0) return "~";
  if (rest[0] !== "/" && rest[0] !== "\\") return path;
  return `~${rest}`;
}
