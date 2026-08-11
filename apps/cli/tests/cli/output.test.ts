import { describe, expect, test } from "bun:test";
import { printCost, USAGE } from "../../src/cli/output";

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
