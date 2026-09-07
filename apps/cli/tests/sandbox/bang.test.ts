import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { executeBang, submitBang, BANG_USAGE, type BangRunners } from "../../src/sandbox/bang";
import {
  BANG_REFUSED_REASON,
  resolveShellLaunch,
  type SandboxPolicy,
} from "../../src/sandbox/policy";
import type { ProcessResult } from "../../src/tools/spawnCollect";

const empty: ProcessResult = {
  stdout: "",
  stderr: "",
  exitCode: 0,
  stdoutTruncated: false,
  stderrTruncated: false,
  timedOut: false,
};

function denied(message: string): ProcessResult {
  return { ...empty, exitCode: 1, stderr: message };
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function isInside(root: string, path: string): boolean {
  const resolved = path.endsWith("/") ? path.slice(0, -1) : path;
  return resolved === root || resolved.startsWith(`${root}/`);
}

function touchPath(command: string): string | undefined {
  const match = /^touch\s+(\S+)$/.exec(command.trim());
  return match?.[1];
}

function confinedRunners(
  root: string,
  outside: string,
): BangRunners & { unsandboxedCalls: number } {
  const state = { unsandboxedCalls: 0 };
  return {
    get unsandboxedCalls() {
      return state.unsandboxedCalls;
    },
    sandboxed: async (command, sandboxRoot) => {
      const dest = touchPath(command);
      if (dest !== undefined && !isInside(sandboxRoot, dest)) {
        return denied("sandbox: write denied");
      }
      if (dest !== undefined) {
        writeFileSync(dest, "");
      }
      return empty;
    },
    unsandboxed: async (command) => {
      state.unsandboxedCalls += 1;
      const dest = touchPath(command) ?? outside;
      writeFileSync(dest, "escaped");
      return empty;
    },
  };
}

describe("executeBang", () => {
  test("strict floor with confinement cannot write outside the root and never takes the unsandboxed runner", async () => {
    const root = tempDir("seri-bang-root-");
    const outside = join(tempDir("seri-bang-out-"), "escaped");
    const policy: SandboxPolicy = { allowUnsandboxedCommands: false, root };
    const launch = resolveShellLaunch("bang", policy, { available: true });
    const runners = confinedRunners(root, outside);
    const executed = await executeBang(`touch ${outside}`, launch, runners, root);
    expect(executed.declared).toBe("os");
    expect(executed.refused).toBeUndefined();
    expect(executed.result?.exitCode).toBe(1);
    expect(executed.result?.stderr).toBe("sandbox: write denied");
    expect(runners.unsandboxedCalls).toBe(0);
    expect(existsSync(outside)).toBe(false);
  });

  test("allowed bang writes outside and declares unsandboxed", async () => {
    const root = tempDir("seri-bang-root-");
    const outside = join(tempDir("seri-bang-out-"), "escaped");
    const policy: SandboxPolicy = { allowUnsandboxedCommands: true, root };
    const launch = resolveShellLaunch("bang", policy, { available: true });
    const runners = confinedRunners(root, outside);
    const executed = await executeBang(`touch ${outside}`, launch, runners, root);
    expect(launch.declared).toBe("unsandboxed");
    expect(executed.declared).toBe("unsandboxed");
    expect(runners.unsandboxedCalls).toBe(1);
    expect(existsSync(outside)).toBe(true);
  });

  test("strict floor without confinement refuses and does not spawn", async () => {
    const root = tempDir("seri-bang-root-");
    const outside = join(tempDir("seri-bang-out-"), "escaped");
    const policy: SandboxPolicy = { allowUnsandboxedCommands: false, root };
    const launch = resolveShellLaunch("bang", policy, { available: false });
    const runners = confinedRunners(root, outside);
    const executed = await executeBang(`touch ${outside}`, launch, runners, root);
    expect(executed.refused).toBeDefined();
    expect(executed.result).toBeUndefined();
    expect(runners.unsandboxedCalls).toBe(0);
    expect(existsSync(outside)).toBe(false);
  });
});

describe("submitBang", () => {
  test("empty command errors with usage and does not spawn", async () => {
    const root = tempDir("seri-bang-empty-");
    const outside = join(tempDir("seri-bang-empty-out-"), "escaped");
    const policy: SandboxPolicy = { allowUnsandboxedCommands: true, root };
    const launch = resolveShellLaunch("bang", policy, { available: true });
    const runners = confinedRunners(root, outside);
    const errors: string[] = [];
    const outputs: string[] = [];
    await submitBang("", launch, runners, root, {
      error: (message) => errors.push(message),
      output: (text) => outputs.push(text),
    });
    expect(errors).toEqual([BANG_USAGE]);
    expect(outputs).toEqual([]);
    expect(runners.unsandboxedCalls).toBe(0);
  });

  test("strict floor without confinement reports the refuse reason and does not spawn", async () => {
    const root = tempDir("seri-bang-submit-refuse-");
    const outside = join(tempDir("seri-bang-submit-refuse-out-"), "escaped");
    const policy: SandboxPolicy = { allowUnsandboxedCommands: false, root };
    const launch = resolveShellLaunch("bang", policy, { available: false });
    const runners = confinedRunners(root, outside);
    const errors: string[] = [];
    await submitBang(`touch ${outside}`, launch, runners, root, {
      error: (message) => errors.push(message),
      output: () => {
        throw new Error("refused bang must not emit output");
      },
    });
    expect(errors).toEqual([BANG_REFUSED_REASON]);
    expect(runners.unsandboxedCalls).toBe(0);
    expect(existsSync(outside)).toBe(false);
  });

  test("allowed bang writes outside and surfaces stdout", async () => {
    const root = tempDir("seri-bang-submit-allow-");
    const outside = join(tempDir("seri-bang-submit-allow-out-"), "escaped");
    const policy: SandboxPolicy = { allowUnsandboxedCommands: true, root };
    const launch = resolveShellLaunch("bang", policy, { available: true });
    const runners = confinedRunners(root, outside);
    const outputs: string[] = [];
    await submitBang(`touch ${outside}`, launch, runners, root, {
      error: (message) => {
        throw new Error(message);
      },
      output: (text) => outputs.push(text),
    });
    expect(launch.declared).toBe("unsandboxed");
    expect(runners.unsandboxedCalls).toBe(1);
    expect(existsSync(outside)).toBe(true);
    expect(outputs).toEqual(["(exit 0)"]);
  });
});
