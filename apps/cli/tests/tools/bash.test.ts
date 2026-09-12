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

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

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

  test("times out a long-running command", async () => {
    const started = Date.now();
    const result = await runBash("sleep 45", 1500);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  test("a command that reads stdin does not consume later script lines", async () => {
    const result = await runBash("cat\necho AFTER_CAT");
    expect(result.stdout.trim()).toBe("AFTER_CAT");
    expect(result.exitCode).toBe(0);
  }, 15000);

  test("a PATH change after the first resolution is not observed by a later call", async () => {
    const warm = await runBash("echo hi");
    expect(warm.stdout.trim()).toBe("hi");

    const stubDir = mkdtempSync(join(tmpdir(), "seri-bash-stub-"));
    // findOnPath looks for bash.exe on win32 and bash elsewhere.
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
      expect(calls).toBe(2);

      const found = () => "/usr/bin/bash";
      expect(_detectBashForTests(found)).toEqual({ command: "/usr/bin/bash", available: true });
      const neverCalled = () => {
        throw new Error("must not be called once a positive result is cached");
      };
      expect(_detectBashForTests(neverCalled)).toEqual({
        command: "/usr/bin/bash",
        available: true,
      });
    } finally {
      _resetBashResolutionForTests();
    }
  });
});

// Windows child.kill() reports success and leaves the shell's process tree running.
describe.skipIf(process.platform !== "win32" || !isBashAvailable())(
  "runBash (timeout kills the tree)",
  () => {
    test("kills what the shell started, not just the shell", async () => {
      const before = countSleepProcesses();

      const result = await runBash("sleep 45", 1500);
      expect(result.timedOut).toBe(true);

      // taskkill returns before Windows has finished reaping the tree.
      await waitFor(() => countSleepProcesses() <= before, 15_000);
      expect(countSleepProcesses()).toBeLessThanOrEqual(before);
    }, 30_000);
  },
);

// Linux procps-ng pkill -f matches bash -c argv. BSD pgrep excludes ancestors, so darwin would
// pass on a bash -c spawn and would not prove the Linux bug. Scripts are command lists so bash
// cannot exec-replace itself with pgrep/pkill, which would then exclude "itself" and hide the
// wrapper.
describe.skipIf(process.platform !== "linux" || !isBashAvailable())(
  "runBash (pkill -f does not match the wrapper argv)",
  () => {
    test("pkill -f with a marker only in the command string leaves the shell alive", async () => {
      const result = await runBash("pkill -f seri-pkill-argv-ce2b-no-target; echo STILL_ALIVE");
      expect(result.stdout.trim()).toBe("STILL_ALIVE");
      expect(result.exitCode).toBe(0);
    }, 15000);

    test("pgrep -af with a marker only in the command string does not print the wrapper", async () => {
      const result = await runBash("pgrep -af seri-pkill-argv-ce2b-pgrep; echo DONE");
      expect(result.stdout.trim()).toBe("DONE");
      expect(result.exitCode).toBe(0);
    }, 15000);

    test("a chained echo still runs after pkill -f kills a real sleep target", async () => {
      try {
        const result = await runBash(
          'sleep 3847 >/dev/null 2>&1 & pkill -f "sleep 3847"; echo STILL_ALIVE_AFTER_REAL_PKILL',
        );
        expect(result.stdout).toContain("STILL_ALIVE_AFTER_REAL_PKILL");
        expect(result.exitCode).toBe(0);
      } finally {
        spawnSync("pkill", ["-f", "sleep 3847"], { stdio: "ignore" });
      }
    }, 15000);
  },
);
