import { describe, expect, test } from "bun:test";
import {
  archivistLine,
  archivistStagedLines,
  archivistStatsLine,
  pendingQueueNotice,
  printCost,
  toolResultLine,
  USAGE,
} from "../../src/cli/output";
import type { ArchivistReport } from "../../src/memory/archivist";
import { ARCHIVIST_MARK } from "../../src/tui/theme/theme";

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
  test("documents serve and exec, not argv config or login", () => {
    expect(USAGE).toContain("seri serve");
    expect(USAGE).toContain("seri exec");
    expect(USAGE).toContain("seri doctor");
    expect(USAGE).toContain("seri update");
    expect(USAGE).not.toContain("seri config");
    expect(USAGE).not.toContain("/setup");
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

  test("renders a subscription turn as included, never a dollar figure", () => {
    const [line] = captureLog(() =>
      printCost({ amountUsd: undefined, status: "included", source: "custom_contract" }),
    );
    expect(line).toBe("(cost: included)");
    expect(line).not.toContain("$");
  });

  test("included wins over a leftover dollar amount from an earlier turn", () => {
    const [line] = captureLog(() =>
      printCost({ amountUsd: 0.002, status: "included", source: "custom_contract" }),
    );
    expect(line).toBe("(cost: included)");
    expect(line).not.toContain("$");
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
    staged: [],
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
    expect(line).toContain("\n  ");
    expect(line.startsWith(ARCHIVIST_MARK)).toBe(true);
  });

  // Coordinator refinement, same round: runSubagent's own generic fallbackSummary filler
  // ("produced no summary", "stopped at the iteration cap…") is not the model's own explanation
  // of what it did, and runArchivist (memory/archivist.ts) sets ArchivistReport.summary to
  // undefined precisely for that case — showing it on every line would be noise, not signal.
  // Negative control for the test above: no second line is appended when there is nothing real
  // to say.
  test("appends nothing when summary is undefined (the child produced only fallback filler)", () => {
    const line = archivistLine(archivistReport({ summary: undefined }));
    expect(line).toBe(
      `${ARCHIVIST_MARK}(archivist: tool-count trigger, 1 tool call, tokens: 100 in, 20 out)`,
    );
    expect(line).not.toContain("\n");
  });

  test("archivistStatsLine equals the undefined-summary archivistLine (mark + stats, no newline)", () => {
    const report = archivistReport({ summary: undefined, staged: [] });
    expect(archivistStatsLine(report)).toBe(archivistLine(report));
    expect(archivistStatsLine(report)).not.toContain("\n");
  });

  // The queue the archivist fills is reviewed by hand, and until this line existed the only way to
  // learn an entry was waiting was to already know to type `/memory pending`. A run that stages
  // must name what it staged.
  test("names every staged write and the command that reviews it", () => {
    const line = archivistLine(
      archivistReport({
        summary: undefined,
        staged: [
          { kind: "memory", id: "a1b2c3d4e5f6", label: "USER.md" },
          { kind: "memory", id: "0f1e2d3c4b5a", label: "myrepo/MEMORY.md" },
          { kind: "skill", id: "9988776655ff", label: "run-migrations" },
        ],
      }),
    );
    expect(line).toContain("staged 2 memory writes: USER.md (a1b2c3d4e5f6)");
    expect(line).toContain("myrepo/MEMORY.md (0f1e2d3c4b5a)");
    expect(line).toContain("/memory pending");
    expect(line).toContain("staged 1 skill: run-migrations (9988776655ff)");
    expect(line).toContain("/skills pending");
  });

  // Negative control for the test above: a run that decided nothing was worth keeping must stay a
  // single stats line, so the notice reads as a real event rather than per-turn furniture.
  test("adds no staged line when the run staged nothing", () => {
    const report = archivistReport({ summary: undefined, staged: [] });
    expect(archivistStagedLines(report)).toEqual([]);
    expect(archivistLine(report)).not.toContain("staged");
  });

  // One line per queue, not one combined line: each has its own review command, and pairing the
  // wrong command with a kind sends the human to a list that does not contain the entry.
  test("splits memory and skills onto their own lines, each with its own review command", () => {
    const lines = archivistStagedLines(
      archivistReport({
        staged: [
          { kind: "skill", id: "9988776655ff", label: "run-migrations" },
          { kind: "memory", id: "a1b2c3d4e5f6", label: "USER.md" },
        ],
      }),
    );
    expect(lines).toEqual([
      `${ARCHIVIST_MARK}staged 1 memory write: USER.md (a1b2c3d4e5f6) · /memory pending`,
      `${ARCHIVIST_MARK}staged 1 skill: run-migrations (9988776655ff) · /skills pending`,
    ]);
  });
});

describe("pendingQueueNotice", () => {
  // The queue a session inherits is the half the per-run lines cannot cover: an earlier session's
  // archivist and the daemon's idle flush both stage with no terminal attached.
  test("names both queues and the command that reviews each", () => {
    expect(pendingQueueNotice(5, 2)).toBe(
      "! 5 memory writes and 2 skills waiting for review · /memory pending, /skills pending",
    );
  });

  test("names only the queue that has entries, singular when there is one", () => {
    expect(pendingQueueNotice(1, 0)).toBe("! 1 memory write waiting for review · /memory pending");
    expect(pendingQueueNotice(0, 1)).toBe("! 1 skill waiting for review · /skills pending");
  });

  // Negative control: an empty queue prints nothing, so this cannot become a line every session
  // start carries regardless of state.
  test("returns undefined when both queues are empty", () => {
    expect(pendingQueueNotice(0, 0)).toBeUndefined();
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
    expect(line).toBe("✓ Dispatched subagents done (2 tasks, 15 tokens)");
  });

  test("dispatch_subagents omits the token clause when totalTokens is undefined", () => {
    const line = toolResultLine({
      type: "tool-result",
      name: "dispatch_subagents",
      result: { results: [{ doneReason: "no-tool-call" }], totalUsage: {} },
    });
    expect(line).toBe("✓ Dispatched subagents done (1 task)");
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
    expect(line).toBe("✓ Dispatched subagents done (1 of 2 tasks)");
  });
});
