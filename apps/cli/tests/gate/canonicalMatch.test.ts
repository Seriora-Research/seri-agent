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

  test("write_file of a lexical .. through a missing prefix still denies the symlink target", () => {
    const { protectedDir, project } = fixture();
    const via = ["missing-dir", "..", "homelink", "secret.txt"].join(sep);
    expect(isInsideWorkingDir(project, via)).toBe(false);
    expect(
      checkPermission("write_file", "auto", undefined, {
        input: { path: via, content: "x" },
        denials: [{ tool: "write_file", pattern: `${protectedDir}/**` }],
        cwd: project,
      }),
    ).toBe("block");
  });

  test("a **/.env glob still matches a .env symlink by its namespace name", () => {
    const project = makeDir("seri-canonical-envglob-");
    writeFileSync(join(project, "secrets.env"), "SECRET");
    writeFileSync(join(project, "plain.env"), "plain");
    symlinkSync(join(project, "secrets.env"), join(project, ".env"));
    const denials = [{ tool: "read_file", pattern: "**/.env" }];
    expect(
      checkPermission("read_file", "auto", undefined, {
        input: { path: ".env" },
        denials,
        cwd: project,
      }),
    ).toBe("block");
    mkdirSync(join(project, "subdir"));
    writeFileSync(join(project, "subdir", ".env"), "nested");
    expect(
      checkPermission("read_file", "auto", undefined, {
        input: { path: join("subdir", ".env") },
        denials,
        cwd: project,
      }),
    ).toBe("block");
    expect(
      checkPermission("read_file", "auto", undefined, {
        input: { path: "secrets.env" },
        denials,
        cwd: project,
      }),
    ).toBe("allow");
  });

  test("write_file collapses .. before following a symlink, matching IO", () => {
    const { protectedDir, project } = fixture();
    const deep = join(project, "sub", "deep", "a");
    mkdirSync(deep, { recursive: true });
    linkDir(deep, join(project, "link"));
    const viaDotDot = ["link", "..", "..", basename(protectedDir), "secret.txt"].join(sep);
    expect(isInsideWorkingDir(project, viaDotDot)).toBe(false);
    expect(
      checkPermission("write_file", "auto", undefined, {
        input: { path: viaDotDot, content: "x" },
        denials: [{ tool: "write_file", pattern: `${protectedDir}/**` }],
        cwd: project,
      }),
    ).toBe("block");
  });

  test("a pnpm-style deep symlink plus .. is classified as the path resolve opens", () => {
    const { protectedDir, project } = fixture();
    const real = join(project, "node_modules", ".pnpm", "foo@1.0.0", "node_modules", "foo");
    mkdirSync(real, { recursive: true });
    mkdirSync(join(project, "node_modules"), { recursive: true });
    linkDir(real, join(project, "node_modules", "foo"));
    const via = [
      "node_modules",
      "foo",
      "..",
      "..",
      "..",
      basename(protectedDir),
      "secret.txt",
    ].join(sep);
    expect(isInsideWorkingDir(project, via)).toBe(false);
    expect(
      checkPermission("read_file", "read-only", undefined, {
        input: { path: via },
        denials: [{ tool: "read_file", pattern: `${protectedDir}/**` }],
        cwd: project,
      }),
    ).toBe("block");
  });

  test("a .. after a symlink in a shell command is resolved against the link target", () => {
    const { protectedDir, project } = fixture();
    const sub = join(project, "sub");
    mkdirSync(sub);
    linkDir(protectedDir, join(sub, "up"));
    const viaDotDot = ["sub", "up", "..", basename(protectedDir), "secret.txt"].join(sep);
    const intent = destructiveIntentOf("bash", { command: `rm -f "${viaDotDot}"` }, project);
    expect(catastrophicOf(intent, project)?.reason).toBe("workspace-escape");
    expect(
      writeFileDenialCovers(
        [{ tool: "write_file", pattern: `${protectedDir}/**` }],
        intent,
        project,
      ),
    ).toBe(true);
    expect(isInsideWorkingDir(project, viaDotDot)).toBe(true);
    expect(
      checkPermission("write_file", "auto", undefined, {
        input: { path: viaDotDot, content: "x" },
        denials: [{ tool: "write_file", pattern: `${protectedDir}/**` }],
        cwd: project,
      }),
    ).toBe("allow");
    const powershell = destructiveIntentOf(
      "powershell",
      { command: `Remove-Item "${viaDotDot}" -Force` },
      project,
    );
    expect(catastrophicOf(powershell, project)).toBeUndefined();
    expect(
      writeFileDenialCovers(
        [{ tool: "write_file", pattern: `${protectedDir}/**` }],
        powershell,
        project,
      ),
    ).toBe(false);
  });

  test("an outside symlink to an inside file is outside, and a deny of the target still matches", () => {
    const project = makeDir("seri-canonical-ns-");
    writeFileSync(join(project, "ok.txt"), "inside");
    const outside = makeDir("seri-canonical-ns-out-");
    const alias = join(outside, "alias");
    symlinkSync(join(project, "ok.txt"), alias);
    expect(isInsideWorkingDir(project, alias)).toBe(false);
    expect(locationForCall(project, "write_file", { path: alias })).toBe("outside");
    expect(
      checkPermission("write_file", "auto", undefined, {
        input: { path: alias, content: "x" },
        denials: [{ tool: "write_file", pattern: join(project, "ok.txt") }],
        cwd: project,
      }),
    ).toBe("block");
  });

  test("a deny whose canonical path contains glob metacharacters still matches only that tree", () => {
    const root = makeDir("seri-canonical-glob-");
    const protectedDir = join(root, "home-folder[1]");
    const decoy = join(root, "home-folder1");
    const project = join(root, "project");
    mkdirSync(protectedDir);
    mkdirSync(decoy);
    mkdirSync(project);
    writeFileSync(join(protectedDir, "secret.txt"), "secret");
    writeFileSync(join(decoy, "secret.txt"), "decoy");
    const denials = [{ tool: "write_file", pattern: `${protectedDir}/**` }];
    expect(
      checkPermission("write_file", "auto", undefined, {
        input: { path: join(protectedDir, "secret.txt"), content: "x" },
        denials,
        cwd: project,
      }),
    ).toBe("block");
    expect(
      checkPermission("write_file", "auto", undefined, {
        input: { path: join(decoy, "secret.txt"), content: "x" },
        denials,
        cwd: project,
      }),
    ).toBe("allow");
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

  test("rm of a project symlink is not a workspace-escape; a write_file deny still covers it", () => {
    const { protectedDir, project, alias } = fixture();
    const intent = destructiveIntentOf("bash", { command: `rm -rf "${alias}"` }, project);
    expect(catastrophicOf(intent, project)).toBeUndefined();
    expect(
      writeFileDenialCovers(
        [{ tool: "write_file", pattern: `${protectedDir}/**` }],
        intent,
        project,
      ),
    ).toBe(true);
  });

  test("rm of a file reached through a project symlink is a workspace-escape", () => {
    const { project, alias } = fixture();
    const through = join(alias, "secret.txt");
    const intent = destructiveIntentOf("bash", { command: `rm -f "${through}"` }, project);
    expect(catastrophicOf(intent, project)?.reason).toBe("workspace-escape");
  });
});

function volumeHasShortNames(): boolean {
  if (process.platform !== "win32") return false;
  const probe = mkdtempSync(join(tmpdir(), "seri-8dot3-probe-longname-"));
  try {
    return windowsShortPath(probe) !== undefined;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

describe.skipIf(!volumeHasShortNames())("Windows 8.3 short names", () => {
  test("a deny on the long path blocks a write through the 8.3 short name", () => {
    const { protectedDir, project } = fixture();
    const short = windowsShortPath(protectedDir);
    if (short === undefined) {
      throw new Error("volumeHasShortNames() passed but the fixture has no 8.3 name");
    }
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
