import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CLI = pathToFileURL(join(import.meta.dir, "../../src/cli.ts")).href;
const TIME_LIMIT = pathToFileURL(join(import.meta.dir, "../../src/loop/timeLimit.ts")).href;

function childScript(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `const { stopReasonOf } = await import(${JSON.stringify(TIME_LIMIT)});`,
    `async function* runLoopFake(opts) {`,
    `  await new Promise((resolve) => opts.signal.addEventListener("abort", resolve, { once: true }));`,
    `  process.kill(process.pid, "SIGINT");`,
    `  await new Promise((resolve) => setTimeout(resolve, 200));`,
    `  yield { type: "done", reason: stopReasonOf(opts.signal) };`,
    `  return opts.messages;`,
    `}`,
    `const code = await cli.run(["--max-duration", "1", "do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  loadAgentsFile: () => "",`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
    `process.exit(code);`,
  ].join("\n");
}

type Exit = { code: number | null; signal: NodeJS.Signals | null; stdout: string };

describe.skipIf(process.platform === "win32")("a time limit and a Ctrl-C", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seri-time-limit-signal-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a Ctrl-C while a timed-out run unwinds still exits 1, not by signal", async () => {
    const child = spawn(process.execPath, ["-e", childScript(dir)], {
      cwd: dir,
      env: { ...process.env, HOME: dir, SERI_DISABLE_MODELS_FETCH: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      let stdout = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      const exit = await new Promise<Exit>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal, stdout }));
      });

      expect(exit.stdout).toContain("(done: timed-out)");
      expect(exit.signal).toBeNull();
      expect(exit.code).toBe(1);
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);
});
