import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionOptions } from "ai";
import { createToolDefinitions, toolDefinitions } from "../../src/provider/tools";
import { isBashAvailable } from "../../src/tools/bash";
import type { GlobResult } from "../../src/tools/glob";
import type { GrepResult } from "../../src/tools/grep";
import { spawnCollect } from "../../src/tools/spawnCollect";

const execOpts: ToolExecutionOptions<Record<string, unknown>> = {
  toolCallId: "test-call",
  messages: [],
  context: {},
};

let dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seri-cwd-test-"));
  dirs.push(dir);
  return dir;
}





function sameResolvedPath(a: string, b: string): boolean {
  return realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase();
}

function canRealpath(path: string): boolean {
  try {
    realpathSync(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("cwd-bound tools", () => {
  test("relative reads currently use process.cwd(), not a session directory", async () => {
    const sessionDir = makeDir();
    writeFileSync(join(sessionDir, "note.txt"), "session-copy");
    expect(() => toolDefinitions.read_file.execute?.({ path: "note.txt" }, execOpts)).toThrow(
      /ENOENT/,
    );
    expect(readFileSync(join(sessionDir, "note.txt"), "utf8")).toBe("session-copy");
  });

  test("two cwd-bound toolsets read different relative files without changing process.cwd()", async () => {
    const originalCwd = process.cwd();
    const dirA = makeDir();
    const dirB = makeDir();
    writeFileSync(join(dirA, "note.txt"), "alpha");
    writeFileSync(join(dirB, "note.txt"), "beta");

    const toolsA = createToolDefinitions(dirA);
    const toolsB = createToolDefinitions(dirB);
    const fromA = await toolsA.read_file.execute?.({ path: "note.txt" }, execOpts);
    const fromB = await toolsB.read_file.execute?.({ path: "note.txt" }, execOpts);

    expect(fromA).toBe("alpha");
    expect(fromB).toBe("beta");
    expect(process.cwd()).toBe(originalCwd);
  });

  test("cwd-bound grep and glob search the injected directory", async () => {
    const dir = makeDir();
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "hit.txt"), "needle-token\n");
    writeFileSync(join(dir, "sub", "other.md"), "");

    const tools = createToolDefinitions(dir);
    const grepResult = (await tools.grep.execute?.(
      { pattern: "needle-token", path: "." },
      execOpts,
    )) as GrepResult;
    const globResult = (await tools.glob.execute?.(
      { pattern: "*.txt", path: "." },
      execOpts,
    )) as GlobResult;

    expect(grepResult.files?.some((file) => file.endsWith("hit.txt"))).toBe(true);
    expect(globResult.files.some((file) => file.endsWith("hit.txt"))).toBe(true);
    expect(globResult.files.some((file) => file.endsWith("other.md"))).toBe(false);
  });

  test("cwd-bound write_file writes into the injected directory", async () => {
    const dir = makeDir();
    const tools = createToolDefinitions(dir);
    await tools.write_file.execute?.({ path: "out.txt", content: "written" }, execOpts);
    expect(readFileSync(join(dir, "out.txt"), "utf8")).toBe("written");
  });

  test.skipIf(!isBashAvailable())(
    "cwd-bound bash reports the injected cwd",
    async () => {
      const dir = makeDir();
      const tools = createToolDefinitions(dir);
      const result = (await tools.bash.execute?.(
        { command: "echo bound > cwd-marker && pwd" },
        execOpts,
      )) as { stdout: string; exitCode: number };
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(dir, "cwd-marker"), "utf8")).toMatch(/bound/);
      const reported = result.stdout.trim();
      if (canRealpath(reported)) expect(sameResolvedPath(reported, dir)).toBe(true);
    },
    15000,
  );

  test.skipIf(process.platform !== "win32")(
    "cwd-bound powershell reports the injected cwd",
    async () => {
      const dir = makeDir();
      const tools = createToolDefinitions(dir);
      const result = (await tools.powershell.execute?.(
        { command: "Set-Content -Path cwd-marker -Value bound; (Get-Location).Path" },
        execOpts,
      )) as { stdout: string; exitCode: number };
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(dir, "cwd-marker"), "utf8")).toMatch(/bound/);
    },
    15000,
  );
});

describe("spawnCollect cwd", () => {
  test("spawns the child in the injected directory", async () => {
    const dir = makeDir();
    const result = await spawnCollect(
      process.execPath,
      ["-e", "process.stdout.write(process.cwd())"],
      undefined,
      undefined,
      dir,
    );
    expect(result.exitCode).toBe(0);
    expect(sameResolvedPath(result.stdout, dir)).toBe(true);
  });
});
