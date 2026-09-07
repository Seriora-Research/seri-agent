import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionOptions } from "ai";
import { ASK_USER_TOOL_NAME } from "../../src/ask-user/types";
import { ASK_PLAN_QUESTIONS_TOOL_NAME, SUBMIT_PLAN_TOOL_NAME } from "../../src/plan/tools";
import {
  classifyBuiltin,
  DISPATCH_TOOL_NAME,
  FS_MUTATING_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
  toolDefinitions,
  WRITE_TOOL_NAMES,
} from "../../src/provider/tools";
import { SKILL_TOOL_NAME } from "../../src/skills/tool";
import { TODO_TOOL_NAME } from "../../src/todo/tool";
import type { GlobResult } from "../../src/tools/glob";
import type { GrepResult } from "../../src/tools/grep";

const execOpts: ToolExecutionOptions<Record<string, unknown>> = {
  toolCallId: "test-call",
  messages: [],
  context: {},
};

let tmpDir: string;

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "seri-tools-adapter-test-"));
}

describe("toolDefinitions", () => {
  test("read_file reads a file's contents", async () => {
    tmpDir = makeTmpDir();
    const filePath = join(tmpDir, "a.txt");
    writeFileSync(filePath, "hello");
    const result = await toolDefinitions.read_file.execute?.({ path: filePath }, execOpts);
    expect(result).toBe("hello");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("read_file execute caps an oversized file before it would enter messages", async () => {
    tmpDir = makeTmpDir();
    const filePath = join(tmpDir, "big.txt");
    writeFileSync(filePath, `HEAD${"x".repeat(200_000)}TAIL`);
    const result = await toolDefinitions.read_file.execute?.({ path: filePath }, execOpts);
    expect(typeof result).toBe("string");
    const text = result as string;
    expect(text.length).toBeLessThan(30_200);
    expect(text.startsWith("HEAD")).toBe(true);
    expect(text.endsWith("TAIL")).toBe(true);
    expect(JSON.stringify(text).length).toBeLessThan(31_000);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("read_file's description names the 30000-character cap", () => {
    expect(toolDefinitions.read_file.description).toContain("30000");
  });

  test("write_file writes content to a file", async () => {
    tmpDir = makeTmpDir();
    const filePath = join(tmpDir, "out.txt");
    const result = await toolDefinitions.write_file.execute?.(
      { path: filePath, content: "written" },
      execOpts,
    );
    expect(readFileSync(filePath, "utf8")).toBe("written");
    expect(result).toMatchObject({ written: true });
    expect(result).not.toHaveProperty("previous");
    expect((result as { change?: { kind: string; added: number } }).change?.kind).toBe("create");
    expect((result as { change?: { added: number } }).change?.added).toBe(1);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("write_file overwrite diffs against the previous bytes and omits them from the result", async () => {
    tmpDir = makeTmpDir();
    const filePath = join(tmpDir, "out.txt");
    writeFileSync(filePath, "old");
    const result = await toolDefinitions.write_file.execute?.(
      { path: filePath, content: "new" },
      execOpts,
    );
    expect(readFileSync(filePath, "utf8")).toBe("new");
    expect(result).not.toHaveProperty("previous");
    expect(JSON.stringify(result)).not.toContain('"previous"');
    expect((result as { change?: { kind: string } }).change?.kind).toBe("update");
    expect(
      (result as { change?: { lines: { text: string }[] } }).change?.lines.map((line) => line.text),
    ).toEqual(["- old", "+ new"]);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("edit replaces oldString with newString", async () => {
    const result = await toolDefinitions.edit.execute?.(
      { content: "hello world", oldString: "world", newString: "there" },
      execOpts,
    );
    expect(result).toBe("hello there");
  });

  test("edit's description says the result has to be written with write_file", () => {
    expect(toolDefinitions.edit.description).toContain("write_file");
  });

  test("grep finds a known pattern", async () => {
    tmpDir = makeTmpDir();
    writeFileSync(join(tmpDir, "a.txt"), "hello world\nfoo bar\n");
    const result = await toolDefinitions.grep.execute?.(
      { pattern: "hello", path: tmpDir },
      execOpts,
    );
    const { mode, files, truncated } = result as GrepResult;
    expect(mode).toBe("files_with_matches");
    expect(files).toHaveLength(1);
    expect(files?.[0]).toContain("a.txt");
    expect(truncated).toBe(false);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("grep passes mode through to return matched lines", async () => {
    tmpDir = makeTmpDir();
    writeFileSync(join(tmpDir, "a.txt"), "hello world\nfoo bar\n");
    const result = await toolDefinitions.grep.execute?.(
      { pattern: "hello", path: tmpDir, mode: "content" },
      execOpts,
    );
    const { mode, matches } = result as GrepResult;
    expect(mode).toBe("content");
    expect(matches).toHaveLength(1);
    expect(matches?.[0].text).toBe("hello world");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("glob lists files matching a pattern", async () => {
    tmpDir = makeTmpDir();
    writeFileSync(join(tmpDir, "a.txt"), "");
    writeFileSync(join(tmpDir, "b.md"), "");
    const result = await toolDefinitions.glob.execute?.(
      { pattern: "*.txt", path: tmpDir },
      execOpts,
    );
    const { files, truncated } = result as GlobResult;
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("a.txt");
    expect(truncated).toBe(false);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("bash runs a command and returns its result", async () => {
    const result = await toolDefinitions.bash.execute?.({ command: "echo hi" }, execOpts);
    expect((result as { stdout: string }).stdout.trim()).toBe("hi");
  }, 15000);

  test.skipIf(process.platform !== "win32")(
    "powershell runs a command and returns its result",
    async () => {
      const result = await toolDefinitions.powershell.execute?.(
        { command: "Write-Output hi" },
        execOpts,
      );
      expect((result as { stdout: string }).stdout.trim()).toBe("hi");
    },
    15000,
  );
});

describe("FS_MUTATING_TOOL_NAMES", () => {
  test("excludes edit", () => {
    expect(FS_MUTATING_TOOL_NAMES).not.toContain("edit");
  });

  test("every name resolves to a real tool definition", () => {
    for (const name of FS_MUTATING_TOOL_NAMES) {
      expect(toolDefinitions[name]).toBeDefined();
    }
  });
});

describe("READ_ONLY_TOOL_NAMES", () => {
  test("is exactly read_file/grep/glob", () => {
    expect([...READ_ONLY_TOOL_NAMES].sort()).toEqual(["glob", "grep", "read_file"]);
  });

  test("shares no member with WRITE_TOOL_NAMES", () => {
    for (const name of READ_ONLY_TOOL_NAMES) {
      expect(WRITE_TOOL_NAMES).not.toContain(name);
    }
  });
});

describe("DISPATCH_TOOL_NAME", () => {
  test("is not a key of toolDefinitions", () => {
    expect(Object.keys(toolDefinitions)).not.toContain(DISPATCH_TOOL_NAME);
  });
});

describe("classifyBuiltin", () => {
  test("classifies every READ_ONLY_TOOL_NAMES entry read", () => {
    for (const name of READ_ONLY_TOOL_NAMES) {
      expect(classifyBuiltin(name)).toBe("read");
    }
  });

  test("classifies every WRITE_TOOL_NAMES entry write", () => {
    for (const name of WRITE_TOOL_NAMES) {
      expect(classifyBuiltin(name)).toBe("write");
    }
  });

  test("plan tools are read-class but not concurrent-read batch members", () => {
    expect(classifyBuiltin(ASK_PLAN_QUESTIONS_TOOL_NAME)).toBe("read");
    expect(classifyBuiltin(SUBMIT_PLAN_TOOL_NAME)).toBe("read");
    expect(READ_ONLY_TOOL_NAMES).not.toContain(ASK_PLAN_QUESTIONS_TOOL_NAME);
    expect(READ_ONLY_TOOL_NAMES).not.toContain(SUBMIT_PLAN_TOOL_NAME);
  });

  test("ask_user is read-class but not a concurrent-read batch member or a toolDefinitions key", () => {
    expect(classifyBuiltin(ASK_USER_TOOL_NAME)).toBe("read");
    expect(READ_ONLY_TOOL_NAMES).not.toContain(ASK_USER_TOOL_NAME);
    expect(WRITE_TOOL_NAMES).not.toContain(ASK_USER_TOOL_NAME);
    expect(Object.keys(toolDefinitions)).not.toContain(ASK_USER_TOOL_NAME);
  });

  test("todo is read-class, not a toolDefinitions key, and not a concurrent-read batch member", () => {
    expect(TODO_TOOL_NAME).toBe("todo");
    expect(classifyBuiltin(TODO_TOOL_NAME)).toBe("read");
    expect(classifyBuiltin("todo")).toBe("read");
    expect(Object.keys(toolDefinitions)).not.toContain(TODO_TOOL_NAME);
    expect(READ_ONLY_TOOL_NAMES).not.toContain(TODO_TOOL_NAME);
    expect(WRITE_TOOL_NAMES).not.toContain(TODO_TOOL_NAME);
    expect(FS_MUTATING_TOOL_NAMES).not.toContain(TODO_TOOL_NAME);
    expect(classifyBuiltin(SKILL_TOOL_NAME)).toBe("read");
  });

  test("classifies a name it has never seen write", () => {
    expect(classifyBuiltin("mcp_exa_web_search")).toBe("write");
    expect(classifyBuiltin("no_tool_has_ever_been_called_this")).toBe("write");
  });
});

describe("memory_write (Stage 6b)", () => {
  test("is not a key of toolDefinitions", () => {
    expect(Object.keys(toolDefinitions)).not.toContain("memory_write");
  });

  test("is in neither WRITE_TOOL_NAMES nor FS_MUTATING_TOOL_NAMES", () => {
    expect(WRITE_TOOL_NAMES).not.toContain("memory_write");
    expect(FS_MUTATING_TOOL_NAMES).not.toContain("memory_write");
  });
});
