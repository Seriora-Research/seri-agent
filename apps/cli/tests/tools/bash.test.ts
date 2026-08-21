import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  _detectBashForTests,
  _resetBashResolutionForTests,
  isBashAvailable,
  runBash,
} from "../../src/tools/bash";

function countSleepProcesses(): number {
  const probe = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", "(Get-Process sleep -EA SilentlyContinue).Count"],
    {
      encoding: "utf8",
    },
  );
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

  // Regression guard for the PATH-resolution memoization fix: a run before this fix scanned PATH
  // fresh on every call (once via isBashAvailable, once via resolveBashCommand), so a PATH change
  // made mid-session could change which bash a later call actually spawns. Warms the cache with a
  // real command first, then prepends a directory holding a broken `bash.exe` stub — if resolution
  // were re-scanned, that stub (matched by name before any real bash further down PATH) would now
  // win and the second command would fail instead of echoing "hi".
  test("a PATH change after the first resolution is not observed by a later call", async () => {
    const warm = await runBash("echo hi");
    expect(warm.stdout.trim()).toBe("hi");

    const stubDir = mkdtempSync(join(tmpdir(), "seri-bash-stub-"));
    // findOnPath only looks for "bash.exe" on win32 — on POSIX it looks for "bash", so a stub
    // literally named "bash.exe" is never a candidate there and this test's negative control never
    // fires on those platforms.
    const stubName = process.platform === "win32" ? "bash.exe" : "bash";
    const stubPath = join(stubDir, stubName);
    writeFileSync(stubPath, "not a real executable");
    if (process.platform !== "win32") chmodSync(stubPath, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${stubDir}${delimiter}${originalPath}`;
    try {
      const result = await runBash("echo hi");
      expect(result.stdout.trim()).toBe("hi");
    } finally {
      process.env.PATH = originalPath;
      rmSync(stubDir, { recursive: true, force: true });
    }
  }, 15000);

  // Regression guard for the negative-caching bug: caching the FOUND case (above) is safe because
  // it cannot un-become true, but caching "not found" would make a mid-session PATH fix (installing
  // Git Bash, or correcting a broken PATH, without restarting seri) invisible for the rest of the
  // process — pre-fix, isBashAvailable()/resolveBashCommand() each re-scanned PATH on every call, so
  // this recovered automatically; the memoization fix had to preserve it for the failure direction
  // even while caching the success direction. Uses _detectBashForTests' injectable finder rather
  // than clearing process.env.PATH: this machine has real Git Bash at a WIN32_GIT_BASH_PATHS
  // fallback location, so an empty PATH alone does not reproduce "not found anywhere" here.
  test("a call after a failed resolution re-runs find instead of trusting the cached failure", () => {
    _resetBashResolutionForTests();
    try {
      let calls = 0;
      const notFound = () => {
        calls++;
        return undefined;
      };

      expect(_detectBashForTests(notFound).available).toBe(false);
      expect(_detectBashForTests(notFound).available).toBe(false);
      expect(calls).toBe(2); // not cached: find() ran again on the second call

      const found = () => "/usr/bin/bash";
      expect(_detectBashForTests(found)).toEqual({ command: "/usr/bin/bash", available: true });
      // Now cached: a THIRD finder is never consulted once a real one has succeeded.
      const neverCalled = () => {
        throw new Error("must not be called once a positive result is cached");
      };
      expect(_detectBashForTests(neverCalled)).toEqual({
        command: "/usr/bin/bash",
        available: true,
      });
    } finally {
      // The fake "/usr/bin/bash" above must not leak into every other test's real bash calls.
      _resetBashResolutionForTests();
    }
  });
});

// Windows-only because the leak this guards against is a Windows behavior, and the probe reads
// the process list through PowerShell. Verified before the fix: child.kill() reported success
// and left `sleep` running, so every timeout would have orphaned a process.
describe.skipIf(process.platform !== "win32" || !isBashAvailable())(
  "runBash (timeout kills the tree)",
  () => {
    test("kills what the shell started, not just the shell", async () => {
      const before = countSleepProcesses();

      const result = await runBash("sleep 45", 1500);
      expect(result.timedOut).toBe(true);

      // taskkill is synchronous but the process table takes a moment to settle.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(countSleepProcesses()).toBeLessThanOrEqual(before);
    }, 30_000);
  },
);
