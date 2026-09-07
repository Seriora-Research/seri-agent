import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool, type ModelMessage, type ToolExecutionOptions, type ToolSet } from "ai";
import { z } from "zod";
import { edit } from "../../src/tools/edit";
import { writeFile } from "../../src/tools/writeFile";
import { writeFileVerification, type CheckOutcome } from "../../src/verify/outcome";
import { withVerification } from "../../src/verify/wrapTools";

const messages: ModelMessage[] = [
  { role: "user", content: "do the task" },
  {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "c1", toolName: "write_file", input: {} }],
  },
];

function execOpts(abortSignal?: AbortSignal): ToolExecutionOptions<Record<string, unknown>> {
  return { toolCallId: "c1", messages, context: {}, abortSignal };
}


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
    {
      file: "src/a.ts",
      line: 12,
      column: 7,
      message: "error TS2322: Type 'number' is not assignable to type 'string'.",
    },
  ],
  inWrittenFile: 1,
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


  test("a diagnostic from the check reaches the tool result the model reads", async () => {
    const wrapped = withVerification(realishTools(), {
      command: "tsc --noEmit",
      runCheck: async () => DIAGNOSTIC_OUTCOME,
    });

    const result = await wrapped.write_file?.execute?.(
      { path: join(root, "a.ts"), content: "x" },
      execOpts(),
    );
    const asModelSeesIt = JSON.stringify(result);

    expect(asModelSeesIt).toContain("src/a.ts");
    expect(asModelSeesIt).toContain("12");
    expect(asModelSeesIt).toContain("Type 'number' is not assignable to type 'string'.");
  });


  test("negative control: with verification disabled the same call carries no diagnostic", async () => {
    const wrapped = withVerification(realishTools(), {
      enabled: false,
      command: "tsc --noEmit",
      runCheck: async () => DIAGNOSTIC_OUTCOME,
    });

    const result = await wrapped.write_file?.execute?.(
      { path: join(root, "a.ts"), content: "x" },
      execOpts(),
    );
    const asModelSeesIt = JSON.stringify(result);

    expect(asModelSeesIt).not.toContain("src/a.ts");
    expect(asModelSeesIt).not.toContain("is not assignable");
    expect(existsSync(join(root, "a.ts"))).toBe(true);
  });

  test("the write still happens, and is reported, whatever the check says", async () => {
    const wrapped = withVerification(realishTools(), {
      command: "tsc --noEmit",
      runCheck: async () => DIAGNOSTIC_OUTCOME,
    });

    const result = await wrapped.write_file?.execute?.(
      { path: join(root, "a.ts"), content: "hello" },
      execOpts(),
    );

    expect(result).toMatchObject({ written: true });
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("hello");
    expect(result).not.toHaveProperty("previous");
    expect((result as { change?: { title: string } }).change?.title).toBe("Write a.ts");
  });

  test("an overwrite's model JSON does not carry the truncated previous body", async () => {
    const marker = "MARKER_SHOULD_NOT_LEAK";
    const previous = Array.from({ length: 40 }, (_, i) => (i === 30 ? marker : `old${i}`)).join(
      "\n",
    );
    const filePath = join(root, "a.ts");
    writeFile(filePath, previous);
    const wrapped = withVerification(realishTools(), { enabled: false });
    const result = await wrapped.write_file?.execute?.(
      {
        path: filePath,
        content: Array.from({ length: 40 }, (_, i) => `new${i}`).join("\n"),
      },
      execOpts(),
    );
    const asModelSeesIt = JSON.stringify(result);
    expect(result).not.toHaveProperty("previous");
    expect(asModelSeesIt).not.toContain(marker);
    expect((result as { change?: { added: number; removed: number } }).change?.added).toBe(40);
    expect((result as { change?: { added: number; removed: number } }).change?.removed).toBe(40);
  });




  test("with no command configured the write succeeds and returns normally", async () => {
    const wrapped = withVerification(realishTools(), {});

    const result = await wrapped.write_file?.execute?.(
      { path: join(root, "a.ts"), content: "hello" },
      execOpts(),
    );

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


    mkdirSync(join(root, "dir"), { recursive: true });
    expect(
      wrapped.write_file?.execute?.({ path: join(root, "dir"), content: "x" }, execOpts()),
    ).rejects.toThrow();
    expect(checks).toBe(0);
  });




  test("every tool but write_file comes back identical by reference", () => {
    const tools = realishTools();
    const wrapped = withVerification(tools, { command: "tsc --noEmit" });

    for (const name of ["read_file", "edit", "grep", "glob", "bash", "powershell"]) {
      expect(wrapped[name]).toBe(tools[name]);
    }
    expect(wrapped.write_file).not.toBe(tools.write_file);
  });



  test("threads the tool call's abortSignal into the check", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const wrapped = withVerification(realishTools(), {
      command: "tsc --noEmit",
      runCheck: async (_command, _writtenPath, signal) => {
        received = signal;
        return DIAGNOSTIC_OUTCOME;
      },
    });

    await wrapped.write_file?.execute?.(
      { path: join(root, "a.ts"), content: "x" },
      execOpts(controller.signal),
    );

    expect(received).toBe(controller.signal);
  });

  test("passes the configured command and the written path to the check", async () => {
    let receivedCommand: string | undefined;
    let receivedPath: string | undefined;
    const target = join(root, "a.ts");
    const wrapped = withVerification(realishTools(), {
      command: "bun run typecheck",
      runCheck: async (command, writtenPath) => {
        receivedCommand = command;
        receivedPath = writtenPath;
        return DIAGNOSTIC_OUTCOME;
      },
    });

    await wrapped.write_file?.execute?.({ path: target, content: "x" }, execOpts());

    expect(receivedCommand).toBe("bun run typecheck");

    expect(receivedPath).toBe(target);
  });
});

describe("writeFileVerification", () => {
  test("narrows a result this module produced", () => {
    expect(writeFileVerification({ written: true, verification: DIAGNOSTIC_OUTCOME })).toEqual(
      DIAGNOSTIC_OUTCOME,
    );
  });

  test("is undefined for results this module did not produce", () => {
    expect(writeFileVerification("edited text")).toBeUndefined();
    expect(writeFileVerification(null)).toBeUndefined();
    expect(writeFileVerification(undefined)).toBeUndefined();
    expect(writeFileVerification({ written: true })).toBeUndefined();
  });
});














const TSC = join(import.meta.dir, "..", "..", "node_modules", "typescript", "lib", "tsc.js");
const BUN_ON_PATH = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;


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

    test("writing a file with a type error puts the real compiler's diagnostic in the tool result", async () => {
      const target = join(project, "a.ts");


      const wrapped = withVerification(realishTools(), {
        command: `bun ${TSC} --noEmit --strict ${target}`,
      });

      const result = await wrapped.write_file?.execute?.(
        { path: target, content: "export const greeting: string = 42;\n" },
        execOpts(),
      );
      const asModelSeesIt = JSON.stringify(result);

      expect(asModelSeesIt).toContain("a.ts");
      expect(asModelSeesIt).toContain("is not assignable to type 'string'");
      expect(result).toMatchObject({ written: true, verification: { status: "diagnostics" } });
    }, 15000);
  },
);
