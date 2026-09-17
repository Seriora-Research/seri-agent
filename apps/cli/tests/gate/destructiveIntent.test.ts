import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  catastrophicOf,
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

describe("catastrophicOf", () => {
  test("rm -rf of a volume root is a volume-root hit in auto-equivalent parsing", () => {
    const intent = destructiveIntentOf("bash", { command: "rm -rf /" }, cwd);
    expect(intent?.recursive).toBe(true);
    expect(catastrophicOf(intent, cwd)).toEqual({ reason: "volume-root", target: "/" });
  });

  test("a Windows drive root is a volume-root hit even on POSIX resolve", () => {
    const quoted = destructiveIntentOf("bash", { command: 'rmdir /s /q "C:\\"' }, cwd);
    expect(quoted?.recursive).toBe(true);
    expect(catastrophicOf(quoted, cwd)?.reason).toBe("volume-root");
    const bare = destructiveIntentOf("bash", { command: "rmdir /s /q C:" }, cwd);
    expect(catastrophicOf(bare, cwd)?.reason).toBe("volume-root");
  });

  test("recursive delete outside the working directory is a workspace-escape", () => {
    const intent = destructiveIntentOf("bash", { command: "rm -rf /tmp/unrelated-tree" }, cwd);
    expect(catastrophicOf(intent, cwd)).toEqual({
      reason: "workspace-escape",
      target: resolve("/tmp/unrelated-tree"),
    });
  });

  test("Remove-Item -Recurse of an absolute outside path is a workspace-escape", () => {
    const intent = destructiveIntentOf(
      "powershell",
      { command: 'Remove-Item "/tmp/unrelated-tree" -Recurse -Force' },
      cwd,
    );
    expect(intent?.recursive).toBe(true);
    expect(catastrophicOf(intent, cwd)?.reason).toBe("workspace-escape");
  });

  test("rm -rf of the working directory itself is a workspace-root hit", () => {
    const intent = destructiveIntentOf("bash", { command: "rm -rf ." }, cwd);
    expect(catastrophicOf(intent, cwd)?.reason).toBe("workspace-root");
  });

  test("rm -rf of a small in-project tree is not catastrophic", () => {
    const intent = destructiveIntentOf("bash", { command: "rm -rf src" }, cwd);
    expect(intent?.targets).toEqual([resolve(cwd, "src")]);
    expect(catastrophicOf(intent, cwd)).toBeUndefined();
  });

  test("tilde home is a workspace-escape when the project is not the home directory", () => {
    const intent = destructiveIntentOf("bash", { command: "rm -rf ~" }, cwd);
    expect(catastrophicOf(intent, cwd)).toEqual({
      reason: "workspace-escape",
      target: homedir(),
    });
  });

  test("recursive remove with no resolved target fails closed", () => {
    const intent = destructiveIntentOf("bash", { command: "rm -rf $EMPTY" }, cwd);
    expect(intent?.recursive).toBe(true);
    expect(intent?.targets).toEqual([]);
    expect(catastrophicOf(intent, cwd)).toEqual({ reason: "unresolved-recursive" });
  });

  test("a parent of the working directory is a workspace-escape", () => {
    const intent = destructiveIntentOf("bash", { command: "rm -rf .." }, cwd);
    expect(catastrophicOf(intent, cwd)?.reason).toBe("workspace-escape");
  });

  test("echo is not catastrophic", () => {
    expect(catastrophicOf(destructiveIntentOf("bash", { command: "echo hi" }, cwd), cwd)).toBe(
      undefined,
    );
  });
});
