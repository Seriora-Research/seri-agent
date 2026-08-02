import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionOptions } from "ai";
import { toolDefinitions } from "../../src/provider/tools";

// Minimal stub satisfying the AI SDK's execute() options param; unused by our adapters.
const execOpts: ToolExecutionOptions<Record<string, unknown>> = { toolCallId: "test-call", messages: [], context: {} };

let tmpDir: string;

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "hesper-tools-adapter-test-"));
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

  test("write_file writes content to a file", async () => {
    tmpDir = makeTmpDir();
    const filePath = join(tmpDir, "out.txt");
    await toolDefinitions.write_file.execute?.({ path: filePath, content: "written" }, execOpts);
    expect(readFileSync(filePath, "utf8")).toBe("written");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("edit replaces oldString with newString", async () => {
    const result = await toolDefinitions.edit.execute?.(
      { content: "hello world", oldString: "world", newString: "there" },
      execOpts,
    );
    expect(result).toBe("hello there");
  });

  test("grep finds a known pattern", async () => {
    tmpDir = makeTmpDir();
    writeFileSync(join(tmpDir, "a.txt"), "hello world\nfoo bar\n");
    const result = await toolDefinitions.grep.execute?.({ pattern: "hello", path: tmpDir }, execOpts);
    expect(result).toHaveLength(1);
    expect((result as { text: string }[])[0].text).toBe("hello world");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("glob lists files matching a pattern", async () => {
    tmpDir = makeTmpDir();
    writeFileSync(join(tmpDir, "a.txt"), "");
    writeFileSync(join(tmpDir, "b.md"), "");
    const result = await toolDefinitions.glob.execute?.({ pattern: "*.txt", path: tmpDir }, execOpts);
    expect(result).toHaveLength(1);
    expect((result as string[])[0]).toContain("a.txt");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("bash runs a command and returns its result", async () => {
    const result = await toolDefinitions.bash.execute?.({ command: "echo hi" }, execOpts);
    expect((result as { stdout: string }).stdout.trim()).toBe("hi");
  });

  test.skipIf(process.platform !== "win32")("powershell runs a command and returns its result", async () => {
    const result = await toolDefinitions.powershell.execute?.({ command: "Write-Output hi" }, execOpts);
    expect((result as { stdout: string }).stdout.trim()).toBe("hi");
  }, 15000);
});
