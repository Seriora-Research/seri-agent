import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnCollect } from "../../src/tools/spawnCollect";

function emit(
  script: string,
): Promise<ReturnType<typeof spawnCollect> extends Promise<infer R> ? R : never> {
  return spawnCollect(process.execPath, ["-e", script]);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

async function waitForPid(file: string): Promise<number> {
  let pid = Number.NaN;
  const reported = await waitFor(() => {
    try {
      pid = Number.parseInt(readFileSync(file, "utf8"), 10);
      return Number.isInteger(pid);
    } catch {
      return false;
    }
  }, 10_000);
  if (!reported) throw new Error("grandchild never reported its pid");
  return pid;
}

describe("spawnCollect", () => {
  test("returns short output whole and does not flag truncation", async () => {
    const result = await emit("process.stdout.write('hi')");

    expect(result.stdout).toBe("hi");
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  test("keeps output that lands exactly on the cap", async () => {
    const result = await emit("process.stdout.write('x'.repeat(30000))");

    expect(result.stdout).toHaveLength(30000);
    expect(result.stdoutTruncated).toBe(false);
  });

  test("keeps output that lands exactly on the cap when a surrogate pair straddles the seam", async () => {
    // Leading 'x' puts a UTF-16 surrogate pair across the 15000-unit seam.
    const result = await emit("process.stdout.write('x' + '\\u{1F600}'.repeat(14999) + 'y')");

    expect(result.stdout).toHaveLength(30000);
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stdout).not.toContain("characters omitted");
    expect(Buffer.from(result.stdout, "utf8").toString("utf8")).toBe(result.stdout);
  }, 30_000);

  test("bounds a runaway command instead of growing without limit", async () => {
    const result = await emit(
      "process.stdout.write('A'.repeat(2_000_000) + 'B'.repeat(2_000_000))",
    );

    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
    expect(result.stdout.length).toBeLessThan(30_200);
    expect(result.stdout.startsWith("A".repeat(100))).toBe(true);
    expect(result.stdout.endsWith("B".repeat(100))).toBe(true);
    expect(result.stdout).toContain("characters omitted");
  });

  test("bounds stderr on the same terms", async () => {
    const result = await emit(
      "process.stdout.write('kept whole'); process.stderr.write('e'.repeat(1_000_000))",
    );

    expect(result.stderrTruncated).toBe(true);
    expect(result.stderr.length).toBeLessThan(30_200);
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stdout).toBe("kept whole");
  });

  test("does not flag a timeout on a command that finishes", async () => {
    const result = await emit("process.stdout.write('done')");

    expect(result.timedOut).toBe(false);
  });

  test("kills a command that outruns its timeout and keeps what it printed first", async () => {
    const started = Date.now();
    const result = await spawnCollect(
      process.execPath,
      ["-e", "process.stdout.write('started work'); setTimeout(() => {}, 60_000)"],
      1500,
    );

    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe("started work");
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  test("preserves a non-zero exit code", async () => {
    const result = await emit("process.stdout.write('partial'); process.exit(3)");

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("partial");
  });

  test("does not strand half a surrogate pair when the cut lands inside one", async () => {
    // Leading 'x' puts a UTF-16 surrogate pair across the 15000-unit head cut.
    const result = await emit("process.stdout.write('x' + '\\u{1F600}'.repeat(1_000_000))");

    expect(result.stdoutTruncated).toBe(true);
    expect(Buffer.from(result.stdout, "utf8").toString("utf8")).toBe(result.stdout);
    expect(result.stdout).not.toContain("�");
  }, 30_000);

  test("does not strand half a pair at the front of the tail either", async () => {
    // Extra trailing char shifts the tail window onto a lone low surrogate.
    const result = await emit("process.stdout.write('x' + '\\u{1F600}'.repeat(200_000) + 'y')");

    expect(result.stdoutTruncated).toBe(true);
    expect(Buffer.from(result.stdout, "utf8").toString("utf8")).toBe(result.stdout);
    expect(result.stdout).not.toContain("�");
  }, 30_000);

  test("does not corrupt multi-byte characters split across stream chunks", async () => {
    const result = await emit("process.stdout.write('é'.repeat(200_000))");

    expect(result.stdout).not.toContain("�");
  });

  test.skipIf(process.platform === "win32")(
    "kills in-flight children when a signal ends the run",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "seri-signal-test-"));
      const pidFile = join(dir, "grandchild.pid");
      const modulePath = pathToFileURL(
        join(import.meta.dir, "../../src/tools/spawnCollect.ts"),
      ).href;

      const grandchild =
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
        `setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000);`;
      const seriSide =
        `const m = await import(${JSON.stringify(modulePath)});` +
        `m.spawnCollect(process.execPath, ["-e", ${JSON.stringify(grandchild)}]);`;

      const child = spawn(process.execPath, ["-e", seriSide], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        const pid = await waitForPid(pidFile);
        expect(isAlive(pid)).toBe(true);

        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));

        // kill(pid, 0) succeeds on a zombie until init reaps it.
        const dead = await waitFor(() => !isAlive(pid), 5_000);
        expect(dead ? "killed" : `grandchild ${pid} survived SIGTERM`).toBe("killed");
      } finally {
        child.kill("SIGKILL");
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test.skipIf(process.platform === "win32")(
    "rejects a cancelled command instead of resolving with a result",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "seri-cancel-test-"));
      const pidFile = join(dir, "child.pid");
      const script =
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
        `setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000);`;

      const controller = new AbortController();
      const running = spawnCollect(process.execPath, ["-e", script], undefined, controller.signal);
      try {
        const pid = await waitForPid(pidFile);
        expect(isAlive(pid)).toBe(true);

        controller.abort();

        await expect(running).rejects.toThrow(/cancelled/);

        // kill(pid, 0) succeeds on a zombie until init reaps it.
        const dead = await waitFor(() => !isAlive(pid), 5_000);
        expect(dead ? "killed" : `child ${pid} survived the cancel`).toBe("killed");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
