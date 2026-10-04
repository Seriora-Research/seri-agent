import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import {
  catastrophicOf,
  destructiveIntentOf,
  writeFileDenialCovers,
} from "../../src/gate/destructiveIntent";
import { checkPermission } from "../../src/gate/gate";
import { isInsideWorkingDir, locationForCall } from "../../src/gate/workingDir";

let dirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function linkDir(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

function windowsShortPath(abs: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  const result = spawnSync("cmd.exe", ["/c", `for %I in ("${abs}") do @echo %~sI`], {
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  const short = result.stdout.trim().split(/\r?\n/).at(-1)?.trim();
  if (short === undefined || short.length === 0) return undefined;
  if (!/~/.test(short)) return undefined;
  return short;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function fixture(): {
  protectedDir: string;
  project: string;
  alias: string;
} {
  const root = makeDir("seri-canonical-");
  const protectedDir = join(root, "home-folder");
  const project = join(root, "project");
  mkdirSync(protectedDir);
  mkdirSync(project);
  writeFileSync(join(protectedDir, "secret.txt"), "secret");
  const alias = join(project, "homelink");
  linkDir(protectedDir, alias);
  return { protectedDir, project, alias };
}

describe("path rules match the canonical target", () => {
  test("a deny on a protected tree blocks write_file through a symlink or junction to that tree", () => {
    const { protectedDir, project, alias } = fixture();
    const denials = [{ tool: "write_file", pattern: `${protectedDir}/**` }];
    expect(
      checkPermission("write_file", "auto", undefined, {
        input: { path: join(alias, "secret.txt"), content: "x" },
        denials,
        cwd: project,
      }),
    ).toBe("block");
    expect(
      checkPermission("write_file", "auto", undefined, {
        input: { path: join(alias, "missing.txt"), content: "x" },
        denials,
        cwd: project,
      }),
    ).toBe("block");
  });

  test("a deny on a protected tree does not block a sibling that is not an alias of it", () => {
    const { protectedDir, project } = fixture();
    expect(
      checkPermission("write_file", "auto", undefined, {
        input: { path: join(project, "ok.txt"), content: "x" },
        denials: [{ tool: "write_file", pattern: `${protectedDir}/**` }],
        cwd: project,
      }),
    ).toBe("allow");
  });

  test("a symlink or junction from the project to a protected tree is outside the working directory", () => {
    const { project, alias } = fixture();
    expect(isInsideWorkingDir(project, join(alias, "secret.txt"))).toBe(false);
    expect(locationForCall(project, "write_file", { path: join(alias, "secret.txt") })).toBe(
      "outside",
    );
    expect(isInsideWorkingDir(project, join(project, "ok.txt"))).toBe(true);
  });

  test("a .. after a symlink component is resolved against the link target, not lexically", () => {
    const { protectedDir, project } = fixture();
    const sub = join(project, "sub");
    mkdirSync(sub);
    linkDir(protectedDir, join(sub, "up"));
    const viaDotDot = ["sub", "up", "..", basename(protectedDir), "secret.txt"].join(sep);
    expect(isInsideWorkingDir(project, viaDotDot)).toBe(false);
    expect(
      checkPermission("write_file", "auto", undefined, {
        input: { path: viaDotDot, content: "x" },
        denials: [{ tool: "write_file", pattern: `${protectedDir}/**` }],
        cwd: project,
      }),
    ).toBe("block");
  });

  test("a symlink that still points inside the working directory stays inside", () => {
    const project = makeDir("seri-canonical-inside-");
    mkdirSync(join(project, "src"));
    writeFileSync(join(project, "src", "a.ts"), "x");
    linkDir(join(project, "src"), join(project, "src-link"));
    expect(isInsideWorkingDir(project, join(project, "src-link", "a.ts"))).toBe(true);
    expect(locationForCall(project, "read_file", { path: join("src-link", "a.ts") })).toBe(
      "inside",
    );
  });

  test("a write_file deny covers Remove-Item of a symlink or junction to that tree", () => {
    const { protectedDir, project, alias } = fixture();
    const intent = destructiveIntentOf(
      "powershell",
      { command: `Remove-Item "${alias}" -Recurse -Force` },
      project,
    );
    expect(
      writeFileDenialCovers(
        [{ tool: "write_file", pattern: `${protectedDir}/**` }],
        intent,
        project,
      ),
    ).toBe(true);
  });

  test("rm -rf of a project symlink to a tree outside the working directory is a workspace-escape", () => {
    const { project, alias } = fixture();
    const intent = destructiveIntentOf("bash", { command: `rm -rf "${alias}"` }, project);
    expect(catastrophicOf(intent, project)?.reason).toBe("workspace-escape");
  });
});

describe.skipIf(process.platform !== "win32")("Windows 8.3 short names", () => {
  test("a deny on the long path blocks a write through the 8.3 short name", () => {
    const { protectedDir, project } = fixture();
    const short = windowsShortPath(protectedDir);
    if (short === undefined) return;
    expect(
      checkPermission("write_file", "auto", undefined, {
        input: { path: join(short, "secret.txt"), content: "x" },
        denials: [{ tool: "write_file", pattern: `${protectedDir}/**` }],
        cwd: project,
      }),
    ).toBe("block");
    expect(isInsideWorkingDir(project, join(short, "secret.txt"))).toBe(false);
    const intent = destructiveIntentOf(
      "powershell",
      { command: `Remove-Item "${short}" -Recurse -Force` },
      project,
    );
    expect(
      writeFileDenialCovers(
        [{ tool: "write_file", pattern: `${protectedDir}/**` }],
        intent,
        project,
      ),
    ).toBe(true);
  });
});
