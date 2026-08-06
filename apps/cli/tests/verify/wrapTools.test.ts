import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool, type ModelMessage, type ToolExecutionOptions, type ToolSet } from "ai";
import { z } from "zod";
import { edit } from "../../src/tools/edit";
import { writeFile } from "../../src/tools/writeFile";
import type { CheckOutcome } from "../../src/verify/run";
import { withVerification, writeFileDiagnosticCount } from "../../src/verify/wrapTools";

const messages: ModelMessage[] = [
  { role: "user", content: "do the task" },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "write_file", input: {} }] },
];

function execOpts(abortSignal?: AbortSignal): ToolExecutionOptions<Record<string, unknown>> {
  return { toolCallId: "c1", messages, context: {}, abortSignal };
}

// Same shape as the real tool set: write_file and edit do the real thing, the rest are inert.
function realishTools(): ToolSet {
  const inert = tool({
    description: "inert",
    inputSchema: z.object({}),
    execute: async () => "ok",
  });
  return {
    write_file: tool({
      description: "write",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => writeFile(path, content),
    }),
    edit: tool({
      description: "edit",
      inputSchema: z.object({ content: z.string(), oldString: z.string(), newString: z.string() }),
      execute: async ({ content, oldString, newString }) => edit(content, oldString, newString),
    }),
    read_file: inert,
    grep: inert,
    glob: inert,
    bash: inert,
    powershell: inert,
  };
}

const DIAGNOSTIC_OUTCOME: CheckOutcome = {
  status: "diagnostics",
  command: "tsc --noEmit",
  elapsedMs: 3600,
  diagnostics: [
    { file: "src/a.ts", line: 12, column: 7, message: "error TS2322: Type 'number' is not assignable to type 'string'." },
  ],
  truncated: false,
  total: 1,
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "seri-verify-wrap-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("withVerification", () => {
  // Acceptance criterion 2. Asserted on JSON.stringify because that is literally what the model
  // receives: loop.ts:354 puts the tool's return value into `{type:"json", value}`.
  test("a diagnostic from the check reaches the tool result the model reads", async () => {
    const wrapped = withVerification(realishTools(), { command: "tsc --noEmit", runCheck: async () => DIAGNOSTIC_OUTCOME });

    const result = await wrapped.write_file?.execute?.({ path: join(root, "a.ts"), content: "x" }, execOpts());
    const asModelSeesIt = JSON.stringify(result);

    expect(asModelSeesIt).toContain("src/a.ts");
    expect(asModelSeesIt).toContain("12");
    expect(asModelSeesIt).toContain("Type 'number' is not assignable to type 'string'.");
  });

  // The negative control for the test above: the same call, the same fake check, feedback off.
  test("negative control: with verification disabled the same call carries no diagnostic", async () => {
    const wrapped = withVerification(realishTools(), {
      enabled: false,
      command: "tsc --noEmit",
      runCheck: async () => DIAGNOSTIC_OUTCOME,
    });

    const result = await wrapped.write_file?.execute?.({ path: join(root, "a.ts"), content: "x" }, execOpts());
    const asModelSeesIt = JSON.stringify(result);

    expect(asModelSeesIt).not.toContain("src/a.ts");
    expect(asModelSeesIt).not.toContain("is not assignable");
    expect(existsSync(join(root, "a.ts"))).toBe(true);
  });

  test("the write still happens, and is reported, whatever the check says", async () => {
    const wrapped = withVerification(realishTools(), { command: "tsc --noEmit", runCheck: async () => DIAGNOSTIC_OUTCOME });

    const result = await wrapped.write_file?.execute?.({ path: join(root, "a.ts"), content: "hello" }, execOpts());

    expect(result).toMatchObject({ written: true });
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("hello");
  });

  // Acceptance criterion 4, and now the default for every user rather than a fallback: no command
  // is configured, so the real runCheck runs, spawns nothing, and the write returns normally. No
  // runCheck is injected — the check that nothing is spawned is the real one.
  test("with no command configured the write succeeds and returns normally", async () => {
    const wrapped = withVerification(realishTools(), {});

    const result = await wrapped.write_file?.execute?.({ path: join(root, "a.ts"), content: "hello" }, execOpts());

    expect(result).toMatchObject({ written: true, verification: { status: "unavailable" } });
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("hello");
  });

  test("a failed write throws as it always did, and runs no check", async () => {
    let checks = 0;
    const wrapped = withVerification(realishTools(), {
      command: "tsc --noEmit",
      runCheck: async () => {
        checks++;
        return DIAGNOSTIC_OUTCOME;
      },
    });

    // A directory cannot be replaced by a file.
    mkdirSync(join(root, "dir"), { recursive: true });
    expect(wrapped.write_file?.execute?.({ path: join(root, "dir"), content: "x" }, execOpts())).rejects.toThrow();
    expect(checks).toBe(0);
  });

  // Mirrors tests/checkpoint/wrapTools.test.ts:59. `edit` is in this list deliberately: this
  // wrapper touches write_file and nothing else, so edit's identity is preserved here exactly as
  // checkpoint/wrapTools.ts:35-36 already promises for its own pass.
  test("every tool but write_file comes back identical by reference", () => {
    const tools = realishTools();
    const wrapped = withVerification(tools, { command: "tsc --noEmit" });

    for (const name of ["read_file", "edit", "grep", "glob", "bash", "powershell"]) {
      expect(wrapped[name]).toBe(tools[name]);
    }
    expect(wrapped.write_file).not.toBe(tools.write_file);
  });

  // Asserted on the signal the RUNNER RECEIVED, not on the wrapper accepting one: a signal
  // dropped one frame below here type-checks and leaves the check unkillable.
  test("threads the tool call's abortSignal into the check", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const wrapped = withVerification(realishTools(), {
      command: "tsc --noEmit",
      runCheck: async (_command, signal) => {
        received = signal;
        return DIAGNOSTIC_OUTCOME;
      },
    });

    await wrapped.write_file?.execute?.({ path: join(root, "a.ts"), content: "x" }, execOpts(controller.signal));

    expect(received).toBe(controller.signal);
  });

  test("passes the configured command to the check", async () => {
    let received: string | undefined;
    const wrapped = withVerification(realishTools(), {
      command: "bun run typecheck",
      runCheck: async (command) => {
        received = command;
        return DIAGNOSTIC_OUTCOME;
      },
    });

    await wrapped.write_file?.execute?.({ path: join(root, "a.ts"), content: "x" }, execOpts());

    expect(received).toBe("bun run typecheck");
  });
});

describe("writeFileDiagnosticCount", () => {
  test("counts the diagnostics on a result this module produced", () => {
    expect(writeFileDiagnosticCount({ written: true, verification: DIAGNOSTIC_OUTCOME })).toBe(1);
  });

  test("is undefined for every other outcome and for results this module did not produce", () => {
    expect(writeFileDiagnosticCount({ written: true, verification: { status: "ok", command: "x", elapsedMs: 1 } })).toBeUndefined();
    expect(writeFileDiagnosticCount("edited text")).toBeUndefined();
    expect(writeFileDiagnosticCount(null)).toBeUndefined();
    expect(writeFileDiagnosticCount(undefined)).toBeUndefined();
  });
});

// The only test in this feature that spawns a real process, so it carries the guards the repo
// already needed for the same symptom (tests/tools/bash.test.ts:17,27,37,
// tests/tools/powershell.test.ts:4,9, tests/provider/tools.test.ts:90,92,95): a skipIf on the
// things it needs, probed by actually running them, and a 15000 ms margin for a cold start.
//
// It runs the repo's own installed tsc rather than a stand-in, so the diagnostic that reaches the
// tool result is one a real compiler emitted, in a real spawned process, parsed by the real parser.
//
// The `bun` half of the guard is not hypothetical and was not derived from the others: this test
// failed under WSL, where bun is installed at ~/.bun/bin/bun but is NOT on a non-interactive
// shell's PATH, so `spawnCollect("bun", ...)` came back "Executable not found in $PATH". The
// production path degrades correctly there — the write stands and the outcome says exactly that —
// but the assertion below needs a real check to have run, so it is skipped instead.
const TSC = join(import.meta.dir, "..", "..", "node_modules", "typescript", "lib", "tsc.js");
const BUN_ON_PATH = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
// runCheck splits the command on whitespace and cannot quote, so a path with a space in it would
// be split in the middle. Skipped rather than left to fail as though the feature were broken.
const PATHS_ARE_SPACE_FREE = !TSC.includes(" ") && !tmpdir().includes(" ");

describe.skipIf(!existsSync(TSC) || !BUN_ON_PATH || !PATHS_ARE_SPACE_FREE)(
  "withVerification (end to end, real check process)",
  () => {
    let project: string;

    beforeEach(() => {
      project = mkdtempSync(join(tmpdir(), "seri-verify-e2e-"));
    });

    afterEach(() => {
      rmSync(project, { recursive: true, force: true });
    });

    test(
      "writing a file with a type error puts the real compiler's diagnostic in the tool result",
      async () => {
        const target = join(project, "a.ts");
        // Exactly what a user would put in SERI_VERIFY_COMMAND: their own toolchain, named
        // explicitly. Nothing here is discovered from the fixture.
        const wrapped = withVerification(realishTools(), { command: `bun ${TSC} --noEmit --strict ${target}` });

        const result = await wrapped.write_file?.execute?.(
          { path: target, content: "export const greeting: string = 42;\n" },
          execOpts(),
        );
        const asModelSeesIt = JSON.stringify(result);

        expect(asModelSeesIt).toContain("a.ts");
        expect(asModelSeesIt).toContain("is not assignable to type 'string'");
        expect(result).toMatchObject({ written: true, verification: { status: "diagnostics" } });
      },
      15000,
    );
  },
);
