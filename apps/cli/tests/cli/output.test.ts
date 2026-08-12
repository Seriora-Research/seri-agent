import { describe, expect, test } from "bun:test";
import { archivistLine, printCost, toolResultLine, USAGE } from "../../src/cli/output";
import type { ArchivistReport } from "../../src/memory/archivist";

function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg: string) => lines.push(String(msg));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

describe("USAGE", () => {
  test("documents /setup and its non-interactive equivalent", () => {
    expect(USAGE).toContain("/setup");
    expect(USAGE).toContain("seri config set");
  });
});

describe("printCost", () => {
  test("renders actual and estimated as visibly different strings", () => {
    const actualLine = captureLog(() =>
      printCost({ amountUsd: 0.0031, status: "actual", source: "provider_cost_api" }),
    )[0];
    const estimatedLine = captureLog(() =>
      printCost({ amountUsd: 0.0004, status: "estimated", source: "provider_models_api" }),
    )[0];

    expect(actualLine).toBe("(cost: $0.0031)");
    expect(estimatedLine).toBe("(cost: ~$0.0004 (estimated))");
    expect(actualLine).not.toBe(estimatedLine);
  });

  test("renders unknown cost without a dollar amount", () => {
    const [line] = captureLog(() =>
      printCost({ amountUsd: undefined, status: "unknown", source: "none" }),
    );
    expect(line).toBe("(cost: unknown)");
  });

  // VERIFY pass 2, HIGH-2: addCost (cli.ts) can carry a defined dollar amount forward from an
  // earlier certain turn while degrading the combined status to "unknown" — status must win over
  // amountUsd's mere presence, or this renders as a plain, falsely-confident dollar figure.
  test("renders a defined amount with status unknown as a partial/uncertain total, not a bare figure", () => {
    const [line] = captureLog(() =>
      printCost({ amountUsd: 0.002, status: "unknown", source: "none" }),
    );
    expect(line).toBe("(cost: ≥ $0.0020, partially unknown)");
    expect(line).not.toBe("(cost: $0.0020)");
  });
});

function archivistReport(overrides: Partial<ArchivistReport> = {}): ArchivistReport {
  return {
    trigger: "tool-count",
    summary: "recorded that this repo uses pnpm",
    usage: {
      inputTokens: 100,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokens: 20,
      outputTokenDetails: { textTokens: 20, reasoningTokens: undefined },
      totalTokens: 120,
    },
    cost: undefined,
    toolCallsMade: 1,
    ...overrides,
  };
}

describe("archivistLine", () => {
  // Round-5 review finding: the summary — the model's own explanation of what it did or
  // decided, its only deliverable — was computed and paid for but never shown anywhere; the only
  // consumer anywhere in the codebase was a test asserting it was defined.
  test("includes the archivist's own summary text, not just the trigger/token/cost stats", () => {
    const line = archivistLine(archivistReport({ summary: "recorded that this repo uses pnpm" }));
    expect(line).toContain("recorded that this repo uses pnpm");
    expect(line).toContain("archivist: tool-count trigger");
  });

  // Coordinator refinement, same round: runSubagent's own generic fallbackSummary filler
  // ("produced no summary", "stopped at the iteration cap…") is not the model's own explanation
  // of what it did, and runArchivist (memory/archivist.ts) sets ArchivistReport.summary to
  // undefined precisely for that case — showing it on every line would be noise, not signal.
  // Negative control for the test above: no second line is appended when there is nothing real
  // to say.
  test("appends nothing when summary is undefined (the child produced only fallback filler)", () => {
    const line = archivistLine(archivistReport({ summary: undefined }));
    expect(line).toBe("(archivist: tool-count trigger, 1 tool call, tokens: 100 in, 20 out)");
    expect(line).not.toContain("\n");
  });
});

describe("toolResultLine", () => {
  test("dispatch_subagents renders task count and total tokens", () => {
    const line = toolResultLine({
      type: "tool-result",
      name: "dispatch_subagents",
      result: {
        results: [{ doneReason: "no-tool-call" }, { doneReason: "no-tool-call" }],
        totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    });
    expect(line).toBe("✓ dispatch_subagents done (2 tasks, 15 tokens)");
  });

  test("dispatch_subagents omits the token clause when totalTokens is undefined", () => {
    const line = toolResultLine({
      type: "tool-result",
      name: "dispatch_subagents",
      result: { results: [{ doneReason: "no-tool-call" }], totalUsage: {} },
    });
    expect(line).toBe("✓ dispatch_subagents done (1 task)");
  });

  // A row with doneReason undefined never ran (batch-cap overflow, or a row this test itself just
  // stands in for) — the count must say so instead of claiming every task ran.
  test("dispatch_subagents renders N of M when some rows never ran", () => {
    const line = toolResultLine({
      type: "tool-result",
      name: "dispatch_subagents",
      result: {
        results: [{ doneReason: "no-tool-call" }, { doneReason: undefined }],
        totalUsage: {},
      },
    });
    expect(line).toBe("✓ dispatch_subagents done (1 of 2 tasks)");
  });
});
