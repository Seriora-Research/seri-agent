import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  destructiveIntentOf,
  followUpBlocked,
  treesOverlap,
  writeFileDenialCovers,
} from "../../src/gate/destructiveIntent";

const cwd = "/tmp/project";

describe("destructiveIntentOf", () => {
  test("parses Remove-Item as remove of the quoted path", () => {
    const intent = destructiveIntentOf(
      "powershell",
      { command: 'Remove-Item "E:\\SS" -Recurse -Force' },
      cwd,
    );
    expect(intent?.kind).toBe("remove");
    expect(intent?.quotingWidened).toBe(false);
    expect(intent?.targets).toEqual([resolve(cwd, "E:/SS")]);
  });

  test("a cmd rmdir trailing-backslash quote widens to the parent", () => {
    const command = 'cmd /c "rmdir /s /q \\"C:\\t\\parent\\sub\\""';
    const intent = destructiveIntentOf("bash", { command }, cwd);
    expect(intent?.kind).toBe("remove");
    expect(intent?.quotingWidened).toBe(true);
    expect(intent?.targets.some((target) => /parent$/.test(target.replaceAll("\\", "/")))).toBe(
      true,
    );
    expect(intent?.targets.some((target) => /sub$/.test(target.replaceAll("\\", "/")))).toBe(false);
  });

  test("robocopy /MOVE is move, not a copy", () => {
    const move = destructiveIntentOf(
      "powershell",
      { command: "robocopy C:\\src C:\\dest /MOVE" },
      cwd,
    );
    expect(move?.kind).toBe("move");
    const copy = destructiveIntentOf(
      "powershell",
      { command: "robocopy C:\\src C:\\dest /E" },
      cwd,
    );
    expect(copy).toBeUndefined();
  });

  test("echo is not destructive", () => {
    expect(destructiveIntentOf("bash", { command: "echo hi" }, cwd)).toBeUndefined();
  });

  test("read_file is never a shell intent", () => {
    expect(destructiveIntentOf("read_file", { path: "/tmp/x" }, cwd)).toBeUndefined();
  });
});

describe("followUpBlocked", () => {
  test("a rmdir of the same tree is blocked after a Remove-Item deny", () => {
    const denied = resolve(cwd, "E:\\SS");
    const follow = destructiveIntentOf("bash", { command: 'cmd /c rmdir /s /q "E:\\SS"' }, cwd);
    expect(follow).toBeDefined();
    if (follow === undefined) throw new Error("expected rmdir intent");
    expect(followUpBlocked([denied], follow)).toBe(true);
  });

  test("a quoting-widened rmdir of the parent is blocked after a subfolder deny", () => {
    const denied = resolve(cwd, "C:\\t\\parent\\sub");
    const follow = destructiveIntentOf(
      "bash",
      { command: 'cmd /c "rmdir /s /q \\"C:\\t\\parent\\sub\\""' },
      cwd,
    );
    expect(follow?.quotingWidened).toBe(true);
    if (follow === undefined) throw new Error("expected quoting-widened rmdir intent");
    expect(followUpBlocked([denied], follow)).toBe(true);
  });

  test("echo is not a follow-up even after a deny", () => {
    expect(destructiveIntentOf("bash", { command: "echo hi" }, cwd)).toBeUndefined();
  });
});

describe("writeFileDenialCovers", () => {
  test("a write_file deny covers Remove-Item of that tree", () => {
    const tree = "/tmp/protected/tree";
    const intent = destructiveIntentOf(
      "powershell",
      { command: `Remove-Item "${tree}" -Recurse -Force` },
      cwd,
    );
    expect(
      writeFileDenialCovers([{ tool: "write_file", pattern: `${tree}/**` }], intent, cwd),
    ).toBe(true);
  });

  test("a write_file deny does not cover echo", () => {
    expect(
      writeFileDenialCovers(
        [{ tool: "write_file", pattern: "/tmp/protected/tree/**" }],
        destructiveIntentOf("bash", { command: "echo hi" }, cwd),
        cwd,
      ),
    ).toBe(false);
  });
});

describe("treesOverlap", () => {
  test("a parent overlaps a child", () => {
    expect(treesOverlap("/tmp/parent", "/tmp/parent/sub")).toBe(true);
    expect(treesOverlap("/tmp/parent/sub", "/tmp/parent")).toBe(true);
    expect(treesOverlap("/tmp/a", "/tmp/b")).toBe(false);
  });
});
