import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnCollect } from "../../src/tools/spawnCollect";

// Drives the current runtime as a child process so the fixtures behave the same on every OS.
function emit(script: string): Promise<ReturnType<typeof spawnCollect> extends Promise<infer R> ? R : never> {
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
    // 30000 units, with the leading 'x' placing every pair on an odd index so one sits exactly
    // across the head/tail boundary. Repairing the seam unconditionally cost a whole pair here
    // and reported a truncation that never happened — on output the same length as the ASCII
    // case above, which passes through whole.
    const result = await emit("process.stdout.write('x' + '\\u{1F600}'.repeat(14999) + 'y')");

    expect(result.stdout).toHaveLength(30000);
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stdout).not.toContain("characters omitted");
    expect(Buffer.from(result.stdout, "utf8").toString("utf8")).toBe(result.stdout);
  }, 30_000);

  test("bounds a runaway command instead of growing without limit", async () => {
    // 4 MB of stdout: unbounded accumulation kept every byte of this and handed it to the model.
    const result = await emit("process.stdout.write('A'.repeat(2_000_000) + 'B'.repeat(2_000_000))");

    expect(result.stdoutTruncated).toBe(true);
    // The stream that was not touched must not be tarred with the same flag.
    expect(result.stderrTruncated).toBe(false);
    // The elision marker adds a little, so this is a bound rather than an exact length.
    expect(result.stdout.length).toBeLessThan(30_200);
    // Both ends survive: the start of the run and the part that would carry an error.
    expect(result.stdout.startsWith("A".repeat(100))).toBe(true);
    expect(result.stdout.endsWith("B".repeat(100))).toBe(true);
    expect(result.stdout).toContain("characters omitted");
  });

  test("bounds stderr on the same terms", async () => {
    const result = await emit("process.stdout.write('kept whole'); process.stderr.write('e'.repeat(1_000_000))");

    expect(result.stderrTruncated).toBe(true);
    expect(result.stderr.length).toBeLessThan(30_200);
    // A flood on stderr must not make a complete stdout look incomplete.
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stdout).toBe("kept whole");
  });

  test("does not flag a timeout on a command that finishes", async () => {
    const result = await emit("process.stdout.write('done')");

    expect(result.timedOut).toBe(false);
  });

  test("kills a command that outruns its timeout and keeps what it printed first", async () => {
    // Prints immediately, then hangs for well past the timeout it is given.
    const started = Date.now();
    const result = await spawnCollect(
      process.execPath,
      ["-e", "process.stdout.write('started work'); setTimeout(() => {}, 60_000)"],
      1500,
    );

    expect(result.timedOut).toBe(true);
    // Returning a bare timeout would leave the agent nothing to diagnose from.
    expect(result.stdout).toBe("started work");
    // It really was killed rather than waited out.
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  test("preserves a non-zero exit code", async () => {
    const result = await emit("process.stdout.write('partial'); process.exit(3)");

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("partial");
  });

  test("does not strand half a surrogate pair when the cut lands inside one", async () => {
    // An emoji is two UTF-16 units. The leading 'x' makes every pair start on an odd index, so
    // the 15000-character head boundary falls between the halves of one and used to leave a
    // lone high surrogate at the end of head. This covers the head cut only: at 2000001 units
    // the last-15000 window opens on a high surrogate, so nothing is stranded at the front of
    // the tail. The test below carries the parity that exercises that side.
    const result = await emit("process.stdout.write('x' + '\\u{1F600}'.repeat(1_000_000))");

    expect(result.stdoutTruncated).toBe(true);
    // A lone surrogate cannot be encoded, so it comes back as U+FFFD and the round trip differs.
    expect(Buffer.from(result.stdout, "utf8").toString("utf8")).toBe(result.stdout);
    expect(result.stdout).not.toContain("�");
  }, 30_000);

  test("does not strand half a pair at the front of the tail either", async () => {
    // The head-side and tail-side cuts fail on opposite parities, so one fixture cannot cover
    // both: the payload above lands the tail on a high surrogate and exercises only the head.
    // The extra trailing character shifts the last-15000 window by one, which is what puts a
    // lone low surrogate first in the tail.
    const result = await emit("process.stdout.write('x' + '\\u{1F600}'.repeat(200_000) + 'y')");

    expect(result.stdoutTruncated).toBe(true);
    expect(Buffer.from(result.stdout, "utf8").toString("utf8")).toBe(result.stdout);
    expect(result.stdout).not.toContain("�");
  }, 30_000);

  test("does not corrupt multi-byte characters split across stream chunks", async () => {
    // A guard, not a reproduction: concatenating raw Buffers held up under this runtime's
    // chunking too (measured: zero U+FFFD). setEncoding makes it a guarantee rather than a
    // property of how bun happens to size chunks, and this test is what holds that line.
    const result = await emit("process.stdout.write('é'.repeat(200_000))");

    expect(result.stdout).not.toContain("�");
  });

  test.skipIf(process.platform === "win32")("kills in-flight children when a signal ends the run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hesper-signal-test-"));
    const pidFile = join(dir, "grandchild.pid");
    const modulePath = pathToFileURL(join(import.meta.dir, "../../src/tools/spawnCollect.ts")).href;

    // The grandchild reports its own pid, because spawnCollect deliberately does not expose the
    // child it spawned. The 60s self-destruct keeps a failing run from stranding it; it is twice
    // the test's own timeout, so it can never turn a red into a green.
    const grandchild =
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
      `setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000);`;
    const hesperSide =
      `const m = await import(${JSON.stringify(modulePath)});` +
      `m.spawnCollect(process.execPath, ["-e", ${JSON.stringify(grandchild)}]);`;

    const child = spawn(process.execPath, ["-e", hesperSide], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      // The pid file is the readiness handshake, not a sleep: it cannot exist until the module was
      // imported (which is what installs the handler) AND spawnCollect actually spawned.
      const pid = await waitForPid(pidFile);
      expect(isAlive(pid)).toBe(true);

      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));

      // Polled, not asserted once: the grandchild is briefly a zombie child of the process we just
      // killed, and kill(pid, 0) succeeds on a zombie until init reaps it.
      const dead = await waitFor(() => !isAlive(pid), 5_000);
      expect(dead ? "killed" : `grandchild ${pid} survived SIGTERM`).toBe("killed");
    } finally {
      child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
