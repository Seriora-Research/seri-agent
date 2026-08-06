import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool, type ModelMessage, type ToolExecutionOptions, type ToolSet } from "ai";
import { z } from "zod";
import { edit } from "../../src/tools/edit";
import { writeFile } from "../../src/tools/writeFile";
import type { CheckOutcome } from "../../src/verify/run";
import { MAX_CONSECUTIVE_EDIT_FAILURES, withVerification } from "../../src/verify/wrapTools";

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
  command: "bun run --cwd /project typecheck",
  elapsedMs: 3600,
  diagnostics: [
    { file: "src/a.ts", line: 12, column: 7, message: "error TS2322: Type 'number' is not assignable to type 'string'." },
  ],
  truncated: false,
  shown: 1,
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
    const wrapped = withVerification(realishTools(), { runCheck: async () => DIAGNOSTIC_OUTCOME });

    const result = await wrapped.write_file?.execute?.({ path: join(root, "a.ts"), content: "x" }, execOpts());
    const asModelSeesIt = JSON.stringify(result);

    expect(asModelSeesIt).toContain("src/a.ts");
    expect(asModelSeesIt).toContain("12");
    expect(asModelSeesIt).toContain("Type 'number' is not assignable to type 'string'.");
  });

  // The negative control for the test above: the same call, the same fake check, feedback off.
  test("negative control: with verification disabled the same call carries no diagnostic", async () => {
    const wrapped = withVerification(realishTools(), { enabled: false, runCheck: async () => DIAGNOSTIC_OUTCOME });

    const result = await wrapped.write_file?.execute?.({ path: join(root, "a.ts"), content: "x" }, execOpts());
    const asModelSeesIt = JSON.stringify(result);

    expect(asModelSeesIt).not.toContain("src/a.ts");
    expect(asModelSeesIt).not.toContain("is not assignable");
    expect(existsSync(join(root, "a.ts"))).toBe(true);
  });

  test("the write still happens, and is reported, whatever the check says", async () => {
    const wrapped = withVerification(realishTools(), { runCheck: async () => DIAGNOSTIC_OUTCOME });

    const result = await wrapped.write_file?.execute?.({ path: join(root, "a.ts"), content: "hello" }, execOpts());

    expect(result).toMatchObject({ written: true });
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("hello");
  });

  // Acceptance criterion 4, with its negative control inline: the fixture is asserted to genuinely
  // have no package.json — and therefore no check script — so "returns normally" is a real result
  // and not a check that would pass against any fixture at all. No runCheck is injected here: the
  // real one runs, detects nothing, and spawns nothing.
  test("a project with no check script writes and returns normally", async () => {
    expect(existsSync(join(root, "package.json"))).toBe(false);
    const wrapped = withVerification(realishTools(), {});

    const result = await wrapped.write_file?.execute?.({ path: join(root, "a.ts"), content: "hello" }, execOpts());

    expect(result).toMatchObject({ written: true, verification: { status: "unavailable" } });
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("hello");
  });

  test("a failed write throws as it always did, and runs no check", async () => {
    let checks = 0;
    const wrapped = withVerification(realishTools(), {
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

  // Mirrors tests/checkpoint/wrapTools.test.ts:59 — a wrapper that rebuilt every entry would
  // change the identity of tools it has no business touching.
  test("tools other than write_file and edit come back identical by reference", () => {
    const tools = realishTools();
    const wrapped = withVerification(tools, {});

    for (const name of ["read_file", "grep", "glob", "bash", "powershell"]) {
      expect(wrapped[name]).toBe(tools[name]);
    }
    expect(wrapped.write_file).not.toBe(tools.write_file);
    expect(wrapped.edit).not.toBe(tools.edit);
  });

  // Asserted on the signal the RUNNER RECEIVED, not on the wrapper accepting one: a signal
  // dropped one frame below here type-checks and leaves the check unkillable.
  test("threads the tool call's abortSignal into the check", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const wrapped = withVerification(realishTools(), {
      runCheck: async (_path, signal) => {
        received = signal;
        return DIAGNOSTIC_OUTCOME;
      },
    });

    await wrapped.write_file?.execute?.({ path: join(root, "a.ts"), content: "x" }, execOpts(controller.signal));

    expect(received).toBe(controller.signal);
  });

  test("passes the written path to the check", async () => {
    let received = "";
    const wrapped = withVerification(realishTools(), {
      runCheck: async (path) => {
        received = path;
        return DIAGNOSTIC_OUTCOME;
      },
    });

    await wrapped.write_file?.execute?.({ path: join(root, "nested", "a.ts"), content: "x" }, execOpts());

    expect(received).toBe(join(root, "nested", "a.ts"));
  });
});

describe("withVerification (consecutive edit failures)", () => {
  const content = "const alpha = 1;\n";

  function failingEdit(wrapped: ToolSet): Promise<unknown> {
    return Promise.resolve(
      wrapped.edit?.execute?.({ content, oldString: "export default class Widget {}", newString: "x" }, execOpts()),
    );
  }

  test("the first failures throw the ordinary message, the third adds the escalation", async () => {
    const wrapped = withVerification(realishTools(), {});

    expect(MAX_CONSECUTIVE_EDIT_FAILURES).toBe(3);
    await expect(failingEdit(wrapped)).rejects.toThrow(/Could not find the specified text/);
    await expect(failingEdit(wrapped)).rejects.not.toThrow(/ask the user/);
    await expect(failingEdit(wrapped)).rejects.toThrow(/ask the user/);
  });

  test("a successful edit in between resets the count", async () => {
    const wrapped = withVerification(realishTools(), {});

    await expect(failingEdit(wrapped)).rejects.toThrow();
    await expect(failingEdit(wrapped)).rejects.toThrow();

    const ok = await wrapped.edit?.execute?.(
      { content, oldString: "const alpha = 1;", newString: "const alpha = 2;" },
      execOpts(),
    );
    expect(ok).toBe("const alpha = 2;\n");

    await expect(failingEdit(wrapped)).rejects.not.toThrow(/ask the user/);
  });
});

// The only test in this feature that spawns a real process, so it carries both guards the repo
// already needed for the same symptom (tests/tools/bash.test.ts:17,27,37,
// tests/tools/powershell.test.ts:4,9, tests/provider/tools.test.ts:90,92,95): a skipIf on the
// thing it needs, and a 15000 ms margin for a cold start.
//
// It runs the repo's own installed tsc rather than a stand-in, so the diagnostic that reaches the
// tool result is one a real compiler emitted, in a real spawned process, parsed by the real parser.
const TSC = join(import.meta.dir, "..", "..", "node_modules", "typescript", "lib", "tsc.js");

describe.skipIf(!existsSync(TSC))("withVerification (end to end, real check process)", () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "seri-verify-e2e-"));
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "fixture", scripts: { typecheck: `bun ${JSON.stringify(TSC)} --noEmit --strict a.ts` } }),
    );
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  test(
    "writing a file with a type error puts the real compiler's diagnostic in the tool result",
    async () => {
      const wrapped = withVerification(realishTools(), {});

      const result = await wrapped.write_file?.execute?.(
        { path: join(project, "a.ts"), content: "export const greeting: string = 42;\n" },
        execOpts(),
      );
      const asModelSeesIt = JSON.stringify(result);

      expect(asModelSeesIt).toContain("a.ts");
      expect(asModelSeesIt).toContain("is not assignable to type 'string'");
      expect(result).toMatchObject({ written: true, verification: { status: "diagnostics" } });
    },
    15000,
  );
});
