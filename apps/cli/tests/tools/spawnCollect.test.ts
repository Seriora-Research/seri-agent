import { describe, expect, test } from "bun:test";
import { spawnCollect } from "../../src/tools/spawnCollect";

// Drives the current runtime as a child process so the fixtures behave the same on every OS.
function emit(script: string): Promise<ReturnType<typeof spawnCollect> extends Promise<infer R> ? R : never> {
  return spawnCollect(process.execPath, ["-e", script]);
}

describe("spawnCollect", () => {
  test("returns short output whole and does not flag truncation", async () => {
    const result = await emit("process.stdout.write('hi')");

    expect(result.stdout).toBe("hi");
    expect(result.truncated).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  test("keeps output that lands exactly on the cap", async () => {
    const result = await emit("process.stdout.write('x'.repeat(30000))");

    expect(result.stdout).toHaveLength(30000);
    expect(result.truncated).toBe(false);
  });

  test("bounds a runaway command instead of growing without limit", async () => {
    // 4 MB of stdout: unbounded accumulation kept every byte of this and handed it to the model.
    const result = await emit("process.stdout.write('A'.repeat(2_000_000) + 'B'.repeat(2_000_000))");

    expect(result.truncated).toBe(true);
    // The elision marker adds a little, so this is a bound rather than an exact length.
    expect(result.stdout.length).toBeLessThan(30_200);
    // Both ends survive: the start of the run and the part that would carry an error.
    expect(result.stdout.startsWith("A".repeat(100))).toBe(true);
    expect(result.stdout.endsWith("B".repeat(100))).toBe(true);
    expect(result.stdout).toContain("characters omitted");
  });

  test("bounds stderr on the same terms", async () => {
    const result = await emit("process.stderr.write('e'.repeat(1_000_000))");

    expect(result.truncated).toBe(true);
    expect(result.stderr.length).toBeLessThan(30_200);
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

  test("does not corrupt multi-byte characters split across stream chunks", async () => {
    // A guard, not a reproduction: concatenating raw Buffers held up under this runtime's
    // chunking too (measured: zero U+FFFD). setEncoding makes it a guarantee rather than a
    // property of how bun happens to size chunks, and this test is what holds that line.
    const result = await emit("process.stdout.write('é'.repeat(200_000))");

    expect(result.stdout).not.toContain("�");
  });
});
