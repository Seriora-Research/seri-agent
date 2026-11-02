import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ToolSet, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { runLoop } from "../../src/loop/loop";
import { createToolDefinitions } from "../../src/provider/tools";
import { ToolSpawnEnv } from "../../src/tools/toolSpawnEnv";
import { baseMessages, collect, streamResult, textOnlyChunks, toolCallChunks } from "./fixtures";

let tmpDir: string;
let missing: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "seri-path-denial-"));
  missing = join(tmpDir, "does-not-exist");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function oneCallThenText(toolName: string, input: unknown) {
  return new MockLanguageModelV4({
    doStream: [
      streamResult(toolCallChunks("call-1", toolName, input)),
      streamResult(textOnlyChunks("Done")),
    ],
  });
}

function errorText(events: Awaited<ReturnType<typeof collect>>): string {
  const error = events.find((event) => event.type === "error");
  return error?.type === "error" ? error.error : "";
}

function deniedReason(events: Awaited<ReturnType<typeof collect>>): string {
  const toolMessage = events
    .filter(
      (event): event is Extract<(typeof events)[number], { type: "messages-updated" }> =>
        event.type === "messages-updated",
    )
    .map((event) => event.messages.at(-1))
    .find((message) => message?.role === "tool");
  const content = (toolMessage?.content ?? []) as {
    output: { type: string; reason?: string };
  }[];
  const denied = content.find((part) => part.output.type === "execution-denied");
  return denied?.output.reason ?? "";
}

describe("runLoop path denials", () => {
  for (const toolName of ["glob", "grep", "read_file"] as const) {
    test(`a deny rule on a missing ${toolName} path is a permission denial, not a missing-path probe`, async () => {
      const input =
        toolName === "read_file"
          ? { path: missing }
          : toolName === "glob"
            ? { pattern: "*.txt", path: missing }
            : { pattern: "secret", path: missing };
      const events = await collect(
        runLoop({
          model: oneCallThenText(toolName, input),
          tools: createToolDefinitions(tmpDir, ToolSpawnEnv.inherited),
          messages: baseMessages,
          permissionMode: "auto",
          cwd: tmpDir,
          pathDenials: [{ tool: toolName, pattern: `${tmpDir.replaceAll("\\", "/")}/**` }],
        }),
      );

      expect(events).toContainEqual({
        type: "permission-denied",
        name: toolName,
        reason: "blocked",
      });
      expect(errorText(events)).not.toContain("Path not found");
      expect(errorText(events)).not.toContain("ENOENT");
    });
  }

  test("a missing glob path without a deny rule is still reported as missing, not as a denial", async () => {
    const events = await collect(
      runLoop({
        model: oneCallThenText("glob", { pattern: "*.txt", path: missing }),
        tools: createToolDefinitions(tmpDir, ToolSpawnEnv.inherited),
        messages: baseMessages,
        permissionMode: "auto",
      }),
    );

    expect(events.find((event) => event.type === "permission-denied")).toBeUndefined();
    expect(errorText(events)).toContain(`Path not found: ${missing}`);
  });

  test("the template .env rule denies ./ and absolute spellings of a missing file", async () => {
    const denials = [{ tool: "read_file" as const, pattern: ".env" }];
    for (const path of [".env", "./.env", join(tmpDir, ".env")]) {
      const events = await collect(
        runLoop({
          model: oneCallThenText("read_file", { path }),
          tools: createToolDefinitions(tmpDir, ToolSpawnEnv.inherited),
          messages: baseMessages,
          permissionMode: "auto",
          cwd: tmpDir,
          pathDenials: denials,
        }),
      );
      expect(events).toContainEqual({
        type: "permission-denied",
        name: "read_file",
        reason: "blocked",
      });
      expect(errorText(events)).not.toContain("ENOENT");
    }
  });

  test("a glob deny blocks a .. spelling that resolves onto a missing denied path", async () => {
    const events = await collect(
      runLoop({
        model: oneCallThenText("glob", {
          pattern: "*.txt",
          path: `${tmpDir.replaceAll("\\", "/")}/other/../secret/missing`,
        }),
        tools: createToolDefinitions(tmpDir, ToolSpawnEnv.inherited),
        messages: baseMessages,
        permissionMode: "auto",
        cwd: tmpDir,
        pathDenials: [{ tool: "glob", pattern: `${tmpDir.replaceAll("\\", "/")}/secret/**` }],
      }),
    );
    expect(events).toContainEqual({
      type: "permission-denied",
      name: "glob",
      reason: "blocked",
    });
    expect(errorText(events)).not.toContain("Path not found");
  });

  test("a relative ../denied path from a subdirectory cwd is a permission denial", async () => {
    const app = join(tmpDir, "app");
    const events = await collect(
      runLoop({
        model: oneCallThenText("glob", { pattern: "*.txt", path: "../secret/missing" }),
        tools: createToolDefinitions(app, ToolSpawnEnv.inherited),
        messages: baseMessages,
        permissionMode: "auto",
        cwd: app,
        pathDenials: [{ tool: "glob", pattern: `${tmpDir.replaceAll("\\", "/")}/secret/**` }],
      }),
    );
    expect(events).toContainEqual({
      type: "permission-denied",
      name: "glob",
      reason: "blocked",
    });
    expect(errorText(events)).not.toContain("Path not found");
  });

  test("a path deny tells the model the path matched a deny rule, not to switch tools or run /mode", async () => {
    const events = await collect(
      runLoop({
        model: oneCallThenText("read_file", { path: missing }),
        tools: createToolDefinitions(tmpDir, ToolSpawnEnv.inherited),
        messages: baseMessages,
        permissionMode: "auto",
        cwd: tmpDir,
        pathDenials: [{ tool: "read_file", pattern: `${tmpDir.replaceAll("\\", "/")}/**` }],
      }),
    );
    const reason = deniedReason(events);
    expect(reason).toContain("deny rule");
    expect(reason).not.toContain("/mode");
    expect(reason).not.toContain("does not write");
  });

  test("a path deny never reaches execute", async () => {
    const tools = createToolDefinitions(tmpDir, ToolSpawnEnv.inherited);
    const original = tools.read_file;
    if (original === undefined || original.execute === undefined) {
      throw new Error("expected read_file.execute");
    }
    let probed = 0;
    const sentinel = {
      ...original,
      execute: async () => {
        probed++;
        throw new Error("probed");
      },
    };
    const sentinelTools = { ...tools, read_file: sentinel };

    const withoutDeny = await collect(
      runLoop({
        model: oneCallThenText("read_file", { path: missing }),
        tools: sentinelTools,
        messages: baseMessages,
        permissionMode: "auto",
        cwd: tmpDir,
      }),
    );
    expect(probed).toBe(1);
    expect(errorText(withoutDeny)).toContain("probed");

    probed = 0;
    const withDeny = await collect(
      runLoop({
        model: oneCallThenText("read_file", { path: missing }),
        tools: sentinelTools,
        messages: baseMessages,
        permissionMode: "auto",
        cwd: tmpDir,
        pathDenials: [{ tool: "read_file", pattern: `${tmpDir.replaceAll("\\", "/")}/**` }],
      }),
    );
    expect(probed).toBe(0);
    expect(errorText(withDeny)).not.toContain("probed");
    expect(withDeny).toContainEqual({
      type: "permission-denied",
      name: "read_file",
      reason: "blocked",
    });
  });

  test("a glob deny on a secrets path blocks bash test -f of that path", async () => {
    const secret = join(tmpDir, "secret", "key");
    const executed: string[] = [];
    const tools: ToolSet = {
      bash: tool({
        description: "run bash",
        inputSchema: z.object({ command: z.string() }),
        execute: async ({ command }) => {
          executed.push(command);
          return "yes";
        },
      }),
    };
    const command = `test -f ${secret} && echo yes`;
    const events = await collect(
      runLoop({
        model: oneCallThenText("bash", { command }),
        tools,
        messages: baseMessages,
        permissionMode: "auto",
        cwd: tmpDir,
        pathDenials: [{ tool: "glob", pattern: `${tmpDir.replaceAll("\\", "/")}/secret/**` }],
      }),
    );
    expect(executed).toEqual([]);
    expect(events).toContainEqual({
      type: "permission-denied",
      name: "bash",
      reason: "blocked",
    });
    expect(deniedReason(events)).toContain("deny rule");
  });

  test("a glob deny on a secrets path blocks powershell Test-Path of that path", async () => {
    const secret = join(tmpDir, "secret", "key");
    const executed: string[] = [];
    const tools: ToolSet = {
      powershell: tool({
        description: "run powershell",
        inputSchema: z.object({ command: z.string() }),
        execute: async ({ command }) => {
          executed.push(command);
          return "True";
        },
      }),
    };
    const command = `Test-Path -Path '${secret}'`;
    const events = await collect(
      runLoop({
        model: oneCallThenText("powershell", { command }),
        tools,
        messages: baseMessages,
        permissionMode: "auto",
        cwd: tmpDir,
        pathDenials: [{ tool: "glob", pattern: `${tmpDir.replaceAll("\\", "/")}/secret/**` }],
      }),
    );
    expect(executed).toEqual([]);
    expect(events).toContainEqual({
      type: "permission-denied",
      name: "powershell",
      reason: "blocked",
    });
  });

  test("bash echo with no path still runs under a glob deny", async () => {
    const executed: string[] = [];
    const tools: ToolSet = {
      bash: tool({
        description: "run bash",
        inputSchema: z.object({ command: z.string() }),
        execute: async ({ command }) => {
          executed.push(command);
          return "ok";
        },
      }),
    };
    const events = await collect(
      runLoop({
        model: oneCallThenText("bash", { command: "echo hi" }),
        tools,
        messages: baseMessages,
        permissionMode: "auto",
        cwd: tmpDir,
        pathDenials: [{ tool: "glob", pattern: `${tmpDir.replaceAll("\\", "/")}/secret/**` }],
      }),
    );
    expect(executed).toEqual(["echo hi"]);
    expect(events.find((event) => event.type === "permission-denied")).toBeUndefined();
  });

  test("a path deny does not invoke PreToolUse", async () => {
    const hookSaw: unknown[] = [];
    const events = await collect(
      runLoop({
        model: oneCallThenText("read_file", { path: missing }),
        tools: createToolDefinitions(tmpDir, ToolSpawnEnv.inherited),
        messages: baseMessages,
        permissionMode: "auto",
        cwd: tmpDir,
        pathDenials: [{ tool: "read_file", pattern: `${tmpDir.replaceAll("\\", "/")}/**` }],
        onBeforeTool: async (_subject, input) => {
          hookSaw.push(input);
          return { errors: ["hook ran before gate"] };
        },
      }),
    );
    expect(hookSaw).toEqual([]);
    expect(errorText(events)).not.toContain("hook ran before gate");
    expect(events).toContainEqual({
      type: "permission-denied",
      name: "read_file",
      reason: "blocked",
    });
  });
});
