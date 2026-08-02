import { describe, expect, test } from "bun:test";
import { runPowerShell } from "../../src/tools/powershell";

describe.skipIf(process.platform !== "win32")("runPowerShell", () => {
  test("runs a trivial command", async () => {
    const result = await runPowerShell("Write-Output hi");
    expect(result.stdout.trim()).toBe("hi");
    expect(result.exitCode).toBe(0);
  }, 15000);
});
