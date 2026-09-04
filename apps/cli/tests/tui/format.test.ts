import { describe, expect, test } from "bun:test";
import type { McpPanelRow } from "../../src/mcp/commands";
import {
  DEFAULT_COLUMNS,
  estimateTokens,
  formatDoneLine,
  formatElapsed,
  formatLiveThinkingStatus,
  formatReasoningCaret,
  formatHomePath,
  formatMcpRow,
  formatModeDetail,
  formatTokenProgress,
  MODE_CYCLE_HINT,
  MODE_HINT_COLS,
  MODE_LABEL,
  modeRowHintVisible,
  systemEntryFg,
  type TokenProgress,
} from "../../src/tui/util/format";
import { theme } from "../../src/tui/theme/theme";
import { route } from "./helpers";

describe("systemEntryFg", () => {
  test("quota hard-stop uses the red token; other system lines do not", () => {
    expect(
      systemEntryFg({
        role: "system",
        text: "Included spend this month is used up. Hosted routes will not run until 1 Oct 2026 UTC.",
        kind: "quota-exhausted",
      }),
    ).toBe(theme.quotaExhausted);
    expect(systemEntryFg({ role: "system", text: "✕ boom" })).toBe(theme.text);
    expect(systemEntryFg({ role: "system", text: "hint", muted: true })).toBe(theme.muted);
  });
});

describe("formatElapsed", () => {
  test("under a minute renders as seconds", () => {
    expect(formatElapsed(0)).toBe("0s");
  });

  test("under an hour renders as minutes and seconds", () => {
    expect(formatElapsed(65_000)).toBe("1m 5s");
  });

  test("an hour or more renders as hours and minutes, dropping seconds", () => {
    expect(formatElapsed(3_700_000)).toBe("1h 1m");
  });

  // A negative delta (the system clock moving backward mid-session) clamps to "0s" rather than
  // rendering "-1s".
  test("a negative elapsed clamps to 0s instead of going negative", () => {
    expect(formatElapsed(-1000)).toBe("0s");
  });
});

describe("reasoning caret", () => {
  test("settled caret is span time only", () => {
    expect(formatReasoningCaret(false, 4_000)).toBe("▸ thought · 4s");
    expect(formatReasoningCaret(true, 4_000)).toBe("▾ thought · 4s");
    expect(formatReasoningCaret(false, 72_000)).toBe("▸ thought · 1m 12s");
  });

  test("live pin joins thinking, elapsed, and tokens with dots", () => {
    expect(formatLiveThinkingStatus(false, "4s", "~2100 ↑, ~180 ↓")).toBe(
      "▸ thinking · 4s · ~2100 ↑, ~180 ↓",
    );
    expect(formatLiveThinkingStatus(true, "4s", "~2100 ↑, ~180 ↓")).toBe(
      "▾ thinking · 4s · ~2100 ↑, ~180 ↓",
    );
  });
});

describe("estimateTokens", () => {
  // fx's own test strategy: a chunk-boundary-dependent estimate would flicker as a real stream's
  // SSE framing happens to land differently between two otherwise-identical runs. Splitting a
  // fixed string at every possible index (including mid-word) and asserting the two halves'
  // estimates always sum to the whole's estimate is what proves that can't happen — this fails
  // immediately against a per-chunk-`Math.ceil`ing implementation (see estimateTokens's own
  // comment on why it defers rounding to display time instead).
  const fixed = "The quick brown fox jumps over the lazy dog. Résumé naïve café — emdash, "; // includes multi-byte chars

  test("splitting the string at every index sums to the same total as estimating it whole", () => {
    const whole = estimateTokens(fixed);
    for (let i = 0; i <= fixed.length; i++) {
      const sum = estimateTokens(fixed.slice(0, i)) + estimateTokens(fixed.slice(i));
      expect(sum).toBeCloseTo(whole, 10);
    }
  });
});

describe("formatTokenProgress", () => {
  function progress(overrides: Partial<TokenProgress> = {}): TokenProgress {
    return {
      reconciledInputTokens: 10,
      reconciledOutputTokens: 20,
      liveInputEstimate: 0,
      carriedOutputEstimate: 0,
      liveOutputEstimate: 0,
      exact: true,
      hasGap: false,
      ...overrides,
    };
  }

  test("omits ~ when exact and no gap", () => {
    expect(formatTokenProgress(progress())).toBe("10 ↑, 20 ↓");
  });

  test("prefixes both with ~ when still an estimate", () => {
    expect(formatTokenProgress(progress({ exact: false }))).toBe("~10 ↑, ~20 ↓");
  });

  test("adds the live output estimate on top of the reconciled total", () => {
    expect(formatTokenProgress(progress({ exact: false, liveOutputEstimate: 5 }))).toBe(
      "~10 ↑, ~25 ↓",
    );
  });

  // carriedOutputEstimate holds a PAST call's own stranded output estimate (reconcileUsage,
  // reducer.ts) — it must sum into the output total alongside the reconciled amount and the
  // currently-streaming call's own live estimate, not replace or be shadowed by either.
  test("adds the carried output estimate on top of the reconciled total, alongside the live estimate", () => {
    expect(
      formatTokenProgress(
        progress({ exact: false, carriedOutputEstimate: 8, liveOutputEstimate: 5 }),
      ),
    ).toBe("~10 ↑, ~33 ↓");
  });

  test("adds the live input estimate on top of the reconciled total", () => {
    expect(formatTokenProgress(progress({ exact: false, liveInputEstimate: 7 }))).toBe(
      "~17 ↑, ~20 ↓",
    );
  });

  // A sticky gap earlier in the turn must keep showing `~` even once the most recent
  // reconciliation was itself complete (`exact: true`) — see `TokenProgress`'s own comment.
  test("prefixes both with ~ when hasGap is set, even though exact is true", () => {
    expect(formatTokenProgress(progress({ exact: true, hasGap: true }))).toBe("~10 ↑, ~20 ↓");
  });
});

describe("formatDoneLine", () => {
  function progress(overrides: Partial<TokenProgress> = {}): TokenProgress {
    return {
      reconciledInputTokens: 10,
      reconciledOutputTokens: 20,
      liveInputEstimate: 0,
      carriedOutputEstimate: 0,
      liveOutputEstimate: 0,
      exact: true,
      hasGap: false,
      ...overrides,
    };
  }

  const exact = progress({ reconciledInputTokens: 123, reconciledOutputTokens: 45 });
  const gap = progress({ hasGap: true });
  const rows: Array<{
    name: string;
    reason: Parameters<typeof formatDoneLine>[0];
    tokens?: TokenProgress;
    expected: string;
  }> = [
    {
      name: "happy + exact",
      reason: "no-tool-call",
      tokens: exact,
      expected: `done · ${formatTokenProgress(exact)}`,
    },
    {
      name: "happy + gap/~",
      reason: "no-tool-call",
      tokens: gap,
      expected: `done · ${formatTokenProgress(gap)}`,
    },
    {
      name: "aborted + totals",
      reason: "aborted",
      tokens: exact,
      expected: `done: aborted · ${formatTokenProgress(exact)}`,
    },
    {
      name: "max-iterations + totals",
      reason: "max-iterations",
      tokens: exact,
      expected: `done: max-iterations · ${formatTokenProgress(exact)}`,
    },
    {
      name: "repeated-denials + totals",
      reason: "repeated-denials",
      tokens: exact,
      expected: `done: repeated-denials · ${formatTokenProgress(exact)}`,
    },
    {
      name: "happy missing tokens",
      reason: "no-tool-call",
      expected: "done",
    },
    {
      name: "aborted missing tokens",
      reason: "aborted",
      expected: "done: aborted",
    },
  ];

  for (const row of rows) {
    test(row.name, () => {
      const line = formatDoneLine(row.reason, row.tokens);
      expect(line).toBe(row.expected);
      expect(line).not.toContain("no-tool-call");
      expect(line).not.toContain("(");
      expect(line).not.toContain(")");
      if (row.tokens !== undefined) {
        expect(line).toContain(" \u00B7 ");
        expect(line).not.toContain(" - ");
        expect(line).toContain("↑");
        expect(line).toContain("↓");
      } else {
        expect(line).not.toContain("\u00B7");
      }
    });
  }
});

describe("MODE_LABEL", () => {
  test("carries the three glyph-prefixed permission-mode labels", () => {
    expect(MODE_LABEL["read-only"]).toBe("⏸ read-only mode on");
    expect(MODE_LABEL["approve-each"]).toBe("⏸ approve-each mode on");
    expect(MODE_LABEL.auto).toBe("⏵⏵ bypass permissions on");
  });
});

describe("MODE_CYCLE_HINT", () => {
  test("is the shift+tab hint, with its own leading space", () => {
    expect(MODE_CYCLE_HINT).toBe(" (shift+tab to cycle)");
  });
});

// The mode-indicator row's own model/route suffix, factored out as a pure function so leftover
// packing is testable without mounting a renderer (formatModelRow's own extraction already used
// this reasoning). `width` is the detail budget (space after the indicator; the caller subtracts
// it). Hint visibility is the caller's problem, not this function's. `route` can be undefined —
// runGuidedSetup (cli.ts) mounts App before any provider key exists, so there is genuinely no
// route to show yet.
describe("formatModeDetail", () => {
  const nonRerouted = route();
  const rerouted = route({ provider: "openrouter", rerouted: true, reason: "ANTHROPIC_API_KEY" });
  const modelOnly = "  claude-sonnet-5";
  const withRoute = "  claude-sonnet-5 · your key";
  const withEffort = "  claude-sonnet-5 · your key · high";
  const reroutedSuffix = "  claude-sonnet-5 · → openrouter";
  const gatewaySuffix = "  claude-sonnet-5 · seri";

  test("budget shorter than the model name: no detail", () => {
    expect(formatModeDetail(nonRerouted, modelOnly.length - 1, undefined)).toBe("");
    expect(formatModeDetail(nonRerouted, 0, undefined)).toBe("");
  });

  test("budget that fits the model but not the route: model name, no route", () => {
    expect(formatModeDetail(nonRerouted, modelOnly.length, undefined)).toBe(modelOnly);
    expect(formatModeDetail(nonRerouted, withRoute.length - 1, undefined)).toBe(modelOnly);
  });

  // DEFAULT_COLUMNS is the typical terminal width, not the caller's detail budget — passing it
  // here is a generous leftover. The regression this guards is that a budget of 80 must include
  // the route suffix (length of `  claude-sonnet-5 · your key`), not drop it.
  test("at 80 columns (DEFAULT_COLUMNS): model name and route suffix", () => {
    expect(formatModeDetail(nonRerouted, DEFAULT_COLUMNS, undefined)).toBe(withRoute);
  });

  test("packs the longest suffix that fits the detail budget", () => {
    expect(formatModeDetail(nonRerouted, withEffort.length, "high")).toBe(withEffort);
    expect(formatModeDetail(nonRerouted, withEffort.length - 1, "high")).toBe(withRoute);
    expect(formatModeDetail(nonRerouted, withRoute.length - 1, "high")).toBe(modelOnly);
    expect(formatModeDetail(nonRerouted, modelOnly.length - 1, "high")).toBe("");
  });

  test("budget that fits model+route: 'your key'", () => {
    expect(formatModeDetail(nonRerouted, withRoute.length, undefined)).toBe(withRoute);
  });

  test("a rerouted route: '→ <provider>' when the budget fits", () => {
    expect(formatModeDetail(rerouted, reroutedSuffix.length, undefined)).toBe(reroutedSuffix);
  });

  test("a gateway-served route: 'seri' when the budget fits", () => {
    const gatewayRoute = route({ credential: "gateway" });
    expect(formatModeDetail(gatewayRoute, gatewaySuffix.length, undefined)).toBe(gatewaySuffix);
  });

  test("a subscription-served route: 'chatgpt' when the budget fits", () => {
    const subscriptionRoute = route({
      provider: "openai",
      model: "gpt-5.6-terra",
      credential: "subscription",
    });
    const suffix = "  gpt-5.6-terra · chatgpt";
    expect(formatModeDetail(subscriptionRoute, suffix.length, undefined)).toBe(suffix);
    expect(formatModeDetail(subscriptionRoute, suffix.length, undefined)).not.toContain("your key");
  });

  // Defensive: resolveRoute's own contract makes rerouted plus a "gateway" credential unreachable, but
  // formatModeDetail must not rely on that — a rerouted route always reads "→ provider", never
  // "seri", regardless of what the credential carries.
  test("a rerouted route still reads '→ <provider>' even with a gateway credential", () => {
    const reroutedAndGateway = route({
      provider: "openrouter",
      rerouted: true,
      reason: "ANTHROPIC_API_KEY",
      credential: "gateway",
    });
    expect(formatModeDetail(reroutedAndGateway, reroutedSuffix.length, undefined)).toBe(
      reroutedSuffix,
    );
  });

  // A real catalog id (an OpenRouter id is easily 40+ chars) would otherwise go into the row
  // unbounded — capped to NAME_WIDTH (22, the same width the picker table already truncates model
  // names to), whether the leftover only fits the model or also the route.
  test("long model id is truncated to NAME_WIDTH in both the model-only and full leftovers", () => {
    const longModel = route({ model: "openrouter/deepseek/deepseek-r1-distill-llama-70b" });
    const longModelOnly = "  openrouter/deepseek/d…";
    const longWithRoute = "  openrouter/deepseek/d… · your key";
    expect(formatModeDetail(longModel, longModelOnly.length, undefined)).toBe(longModelOnly);
    expect(formatModeDetail(longModel, longWithRoute.length, undefined)).toBe(longWithRoute);
  });

  test("route === undefined: no detail at every width", () => {
    for (const width of [10, modelOnly.length, DEFAULT_COLUMNS, 100]) {
      expect(formatModeDetail(undefined, width, undefined)).toBe("");
    }
  });

  test("effortTier defined and budget fits: appended after the route label", () => {
    expect(formatModeDetail(nonRerouted, withEffort.length, "high")).toBe(withEffort);
  });

  test("effortTier defined but budget only fits model+route: tier does not appear", () => {
    expect(formatModeDetail(nonRerouted, withRoute.length, "high")).toBe(withRoute);
  });

  test("effortTier undefined: route-only output when the budget fits", () => {
    expect(formatModeDetail(nonRerouted, withRoute.length, undefined)).toBe(withRoute);
  });

  test("an effortTier longer than EFFORT_WIDTH is truncated with a trailing ellipsis", () => {
    const truncated = "  claude-sonnet-5 · your key · extra-t…";
    expect(formatModeDetail(nonRerouted, truncated.length, "extra-thinky")).toBe(truncated);
  });

  test("route === undefined: no detail at every width, even with an effortTier", () => {
    for (const width of [10, modelOnly.length, DEFAULT_COLUMNS, 100]) {
      expect(formatModeDetail(undefined, width, "high")).toBe("");
    }
  });
});

describe("modeRowHintVisible", () => {
  test("hint at MODE_HINT_COLS with empty detail", () => {
    expect(modeRowHintVisible(MODE_HINT_COLS, MODE_LABEL["approve-each"].length, 0)).toBe(true);
  });

  test("hint hidden when detail+hint overflow even if remaining >= MODE_HINT_COLS", () => {
    const detail = "  claude-sonnet-5 · your key";
    expect(
      modeRowHintVisible(MODE_HINT_COLS, MODE_LABEL["approve-each"].length, detail.length),
    ).toBe(false);
    const worstDetail = `  ${"n".repeat(22)} · → openrouter · high`;
    expect(modeRowHintVisible(DEFAULT_COLUMNS, MODE_LABEL.auto.length, worstDetail.length)).toBe(
      false,
    );
  });
});

describe("formatMcpRow", () => {
  test("a header row renders the scope and its source file", () => {
    const row: McpPanelRow = {
      kind: "header",
      scope: "project",
      sourceFile: ".seri/mcp/servers.yaml",
    };
    expect(formatMcpRow(row)).toBe("Project (.seri/mcp/servers.yaml)");
  });

  test("a header row for the user scope renders as User", () => {
    const row: McpPanelRow = {
      kind: "header",
      scope: "user",
      sourceFile: "/home/lioar/.seri/mcp/servers.yaml",
    };
    expect(formatMcpRow(row)).toBe("User (/home/lioar/.seri/mcp/servers.yaml)");
  });

  test("a connected server renders its name, status word, and cached tool count with no mark", () => {
    const row: McpPanelRow = {
      kind: "server",
      name: "exa",
      scope: "user",
      status: { state: "connected", toolCount: 4 },
      toolCount: 4,
    };
    expect(formatMcpRow(row)).toBe("exa · connected · 4 tools");
  });

  test("a needs-auth server is marked with WARNING_MARK, never a color", () => {
    const row: McpPanelRow = {
      kind: "server",
      name: "vercel",
      scope: "project",
      status: { state: "needs-auth" },
      toolCount: undefined,
    };
    expect(formatMcpRow(row)).toBe("vercel · ! needs authentication");
  });

  test("an unreachable server is marked with ERROR_MARK", () => {
    const row: McpPanelRow = {
      kind: "server",
      name: "supabase",
      scope: "project",
      status: { state: "failed", message: "ECONNREFUSED" },
      toolCount: undefined,
    };
    expect(formatMcpRow(row)).toBe("supabase · ✕ unreachable");
  });

  test("an idle server with no cached catalog shows no tool count", () => {
    const row: McpPanelRow = {
      kind: "server",
      name: "notion",
      scope: "user",
      status: { state: "idle" },
      toolCount: undefined,
    };
    expect(formatMcpRow(row)).toBe("notion · idle, connects on first use");
  });

  test("a single cached tool is singular, not plural", () => {
    const row: McpPanelRow = {
      kind: "server",
      name: "exa",
      scope: "user",
      status: { state: "connected", toolCount: 1 },
      toolCount: 1,
    };
    expect(formatMcpRow(row)).toBe("exa · connected · 1 tool");
  });
});

describe("formatHomePath", () => {
  test("a path under the home directory collapses to ~", () => {
    expect(formatHomePath("C:\\Users\\lion\\code\\seri", "C:\\Users\\lion")).toBe("~\\code\\seri");
    expect(formatHomePath("/home/lion/code/seri", "/home/lion")).toBe("~/code/seri");
  });

  test("the home directory itself is just ~", () => {
    expect(formatHomePath("/home/lion", "/home/lion")).toBe("~");
  });

  // The separator check earns its place here: "/home/lion-old" starts with the home string but is
  // a different directory, and rewriting it to "~-old" would name a path that does not exist.
  test("a sibling directory sharing the home prefix is left alone", () => {
    expect(formatHomePath("/home/lion-old/code", "/home/lion")).toBe("/home/lion-old/code");
    expect(formatHomePath("/srv/build", "/home/lion")).toBe("/srv/build");
  });

  test("an unknown home leaves the path untouched", () => {
    expect(formatHomePath("/srv/build", "")).toBe("/srv/build");
  });
});
