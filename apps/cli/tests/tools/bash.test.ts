import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { isBashAvailable, runBash } from "../../src/tools/bash";

function countSleepProcesses(): number {
  const probe = spawnSync("powershell", ["-NoProfile", "-Command", "(Get-Process sleep -EA SilentlyContinue).Count"], {
    encoding: "utf8",
  });
  return Number(probe.stdout.trim()) || 0;
}

describe("runBash", () => {
  test("runs a trivial command", async () => {
    const result = await runBash("echo hi");
    expect(result.stdout.trim()).toBe("hi");
    expect(result.exitCode).toBe(0);
  }, 15000);

  test("rejects before spawning when bash is unavailable", () => {
    expect(runBash("echo hi", undefined, undefined, () => false)).rejects.toThrow();
  });
});

// Windows-only because the leak this guards against is a Windows behavior, and the probe reads
// the process list through PowerShell. Verified before the fix: child.kill() reported success
// and left `sleep` running, so every timeout would have orphaned a process.
describe.skipIf(process.platform !== "win32" || !isBashAvailable())("runBash (timeout kills the tree)", () => {
  test("kills what the shell started, not just the shell", async () => {
    const before = countSleepProcesses();

    const result = await runBash("sleep 45", 1500);
    expect(result.timedOut).toBe(true);

    // taskkill is synchronous but the process table takes a moment to settle.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(countSleepProcesses()).toBeLessThanOrEqual(before);
  }, 30_000);
});
