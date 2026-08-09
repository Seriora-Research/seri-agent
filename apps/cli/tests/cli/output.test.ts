import { describe, expect, test } from "bun:test";
import { printCost } from "../../src/cli/output";

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
});
