import { describe, expect, test } from "bun:test";
import type { ProcessResult } from "../../src/tools/spawnCollect";
import { MAX_DIAGNOSTICS, runCheck } from "../../src/verify/run";

const OK: ProcessResult = {
  stdout: "",
  stderr: "",
  exitCode: 0,
  stdoutTruncated: false,
  stderrTruncated: false,
  timedOut: false,
};

type SpawnCall = { executable: string; args: string[]; timeoutMs: number | undefined; signal: AbortSignal | undefined };

// A fake runner rather than a real spawn, so nothing in this file needs a platform guard or a
// 15000 ms margin: only the e2e test in wrapTools.test.ts spawns for real, and it carries both.
function fakeSpawn(result: Partial<ProcessResult>, calls: SpawnCall[] = []) {
  return {
    calls,
    spawn: (executable: string, args: string[], timeoutMs?: number, signal?: AbortSignal) => {
      calls.push({ executable, args, timeoutMs, signal });
      return Promise.resolve({ ...OK, ...result });
    },
  };
}

describe("runCheck", () => {
  // The default for every user, and the reason there is no auto-discovery left: with nothing
  // configured, seri does not go looking for a command to run.
  test("reports unavailable, and spawns nothing at all, when no command is configured", async () => {
    const runner = fakeSpawn({});
    const outcome = await runCheck(undefined, "src/written.ts", undefined, { spawn: runner.spawn });

    expect(outcome).toMatchObject({ status: "unavailable" });
    expect(runner.calls).toEqual([]);
  });

  test("splits the configured command into an executable and its arguments", async () => {
    const runner = fakeSpawn({});
    await runCheck("bun run typecheck", "src/written.ts", undefined, { spawn: runner.spawn });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].executable).toBe("bun");
    expect(runner.calls[0].args).toEqual(["run", "typecheck"]);
  });

  // The signal is asserted on the value the RUNNER RECEIVED, not on runCheck accepting a
  // parameter: a signal that is declared and dropped one frame later type-checks, passes every
  // gate, and leaves the check unkillable. Measured precedent for exactly that shape is recorded
  // in .claude/rules/engineering-loop.md.
  test("threads the caller's AbortSignal through to the process runner", async () => {
    const controller = new AbortController();
    const runner = fakeSpawn({});
    await runCheck("tsc --noEmit", "src/written.ts", controller.signal, { spawn: runner.spawn });

    expect(runner.calls[0].signal).toBe(controller.signal);
  });

  test("exit 0 with nothing parseable is ok, and reports what ran and what it cost", async () => {
    const runner = fakeSpawn({ stdout: "$ tsc --noEmit\n" });
    const outcome = await runCheck("tsc --noEmit", "src/written.ts", undefined, { spawn: runner.spawn });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.command).toBe("tsc --noEmit");
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("returns the parsed diagnostics", async () => {
    const runner = fakeSpawn({
      stdout: "src/a.ts(12,7): error TS2322: Type 'number' is not assignable to type 'string'.\n",
      exitCode: 1,
    });
    const outcome = await runCheck("tsc --noEmit", "src/written.ts", undefined, { spawn: runner.spawn });

    expect(outcome).toMatchObject({
      status: "diagnostics",
      total: 1,
      truncated: false,
      diagnostics: [
        {
          file: "src/a.ts",
          line: 12,
          column: 7,
          message: "error TS2322: Type 'number' is not assignable to type 'string'.",
        },
      ],
    });
  });

  test("caps the diagnostics fed back, and still reports the true total", async () => {
    const flood = Array.from({ length: 57 }, (_, i) => `src/a.ts(${i + 1},1): error TS2304: Cannot find name 'x'.`).join("\n");
    const runner = fakeSpawn({ stdout: flood, exitCode: 1 });
    const outcome = await runCheck("tsc --noEmit", "src/written.ts", undefined, { spawn: runner.spawn });

    if (outcome.status !== "diagnostics") throw new Error("unreachable");
    expect(MAX_DIAGNOSTICS).toBe(20);
    expect(outcome.diagnostics).toHaveLength(20);
    expect(outcome.total).toBe(57);
  });

  // A project-wide check reports the whole repository's debt. Without this the model cannot tell
  // the error it just caused from ones that were already there, and starts editing files it never
  // touched — the failure OpenCode filed as #6310 and #16569.
  test("puts diagnostics in the file just written first, and counts them", async () => {
    const runner = fakeSpawn({
      stdout: [
        "src/other.ts(1,1): error TS2304: Cannot find name 'a'.",
        "src/written.ts(9,2): error TS2322: mine.",
        "src/another.ts(4,1): error TS2304: Cannot find name 'b'.",
        "src/written.ts(3,5): error TS2551: also mine.",
      ].join("\n"),
      exitCode: 1,
    });
    const outcome = await runCheck("tsc --noEmit", "src/written.ts", undefined, { spawn: runner.spawn });

    if (outcome.status !== "diagnostics") throw new Error("unreachable");
    expect(outcome.diagnostics.map((d) => d.file)).toEqual([
      "src/written.ts",
      "src/written.ts",
      "src/other.ts",
      "src/another.ts",
    ]);
    expect(outcome.inWrittenFile).toBe(2);
    expect(outcome.total).toBe(4);
  });

  test("counts no diagnostics as being in the written file when none are", async () => {
    const runner = fakeSpawn({ stdout: "src/other.ts(1,1): error TS2304: Cannot find name 'a'.", exitCode: 1 });
    const outcome = await runCheck("tsc --noEmit", "src/written.ts", undefined, { spawn: runner.spawn });

    expect(outcome).toMatchObject({ status: "diagnostics", inWrittenFile: 0 });
  });

  test("propagates spawnCollect's truncation flag, so a partial list can never read as the whole one", async () => {
    const runner = fakeSpawn({
      stdout: "src/a.ts(1,1): error TS2304: Cannot find name 'x'.\n",
      exitCode: 1,
      stdoutTruncated: true,
    });
    const outcome = await runCheck("tsc --noEmit", "src/written.ts", undefined, { spawn: runner.spawn });

    expect(outcome).toMatchObject({ status: "diagnostics", truncated: true });
  });

  // The risk table's "tsc-format parsing is TypeScript-specific" row: a checker whose output this
  // parser cannot read must not come back as a green build.
  test("a non-zero exit with nothing parseable is failed, not ok, and carries the raw tail", async () => {
    const runner = fakeSpawn({ stderr: "cargo: no such subcommand `typecheck`", exitCode: 101 });
    const outcome = await runCheck("cargo typecheck", "src/written.ts", undefined, { spawn: runner.spawn });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.reason).toContain("no such subcommand");
  });

  test("a timed-out check is failed and says so", async () => {
    const runner = fakeSpawn({ exitCode: 1, timedOut: true });
    const outcome = await runCheck("tsc --noEmit", "src/written.ts", undefined, { spawn: runner.spawn });

    expect(outcome).toMatchObject({ status: "failed" });
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.reason).toContain("timed out");
  });

  // A cancelled check rejects (spawnCollect.ts:201-202). The write itself already succeeded, so
  // this must not be re-thrown: that would replace the record of a completed write with a tool error.
  test("a rejecting runner becomes a failed outcome rather than a thrown write", async () => {
    const outcome = await runCheck("tsc --noEmit", "src/written.ts", undefined, { spawn: () => Promise.reject(new Error("cancelled")) });

    expect(outcome).toMatchObject({ status: "failed" });
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.reason).toContain("cancelled");
  });
});
