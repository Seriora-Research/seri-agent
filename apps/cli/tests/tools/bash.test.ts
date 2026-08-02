import { describe, expect, test } from "bun:test";
import { runBash } from "../../src/tools/bash";

describe("runBash", () => {
  test("runs a trivial command", async () => {
    const result = await runBash("echo hi");
    expect(result.stdout.trim()).toBe("hi");
    expect(result.exitCode).toBe(0);
  });

  test("rejects before spawning when bash is unavailable", () => {
    expect(runBash("echo hi", () => false)).rejects.toThrow();
  });
});
