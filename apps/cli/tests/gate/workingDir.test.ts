import { describe, expect, test } from "bun:test";
import { join, resolve, sep } from "node:path";
import {
  isInsideWorkingDir,
  locationForCall,
  pathLocation,
  resolveAgainstCwd,
} from "../../src/gate/workingDir";

const cwd = resolve(join("tmp-wd", "proj"));

describe("resolveAgainstCwd", () => {
  test("joins a relative path onto the session cwd, not process.cwd()", () => {
    expect(resolveAgainstCwd(cwd, "src/a.ts")).toBe(resolve(cwd, "src/a.ts"));
  });

  test("leaves an absolute path unchanged (still normalized by the classifier)", () => {
    const absolute = resolve(join("tmp-wd", "other", "secret.txt"));
    expect(resolveAgainstCwd(cwd, absolute)).toBe(absolute);
  });
});

describe("isInsideWorkingDir", () => {
  test("the working directory itself is inside", () => {
    expect(isInsideWorkingDir(cwd, ".")).toBe(true);
    expect(isInsideWorkingDir(cwd, cwd)).toBe(true);
  });

  test("a nested relative path is inside", () => {
    expect(isInsideWorkingDir(cwd, join("src", "a.ts"))).toBe(true);
  });

  test("a parent traversal is outside", () => {
    expect(isInsideWorkingDir(cwd, join("..", "secret.txt"))).toBe(false);
  });

  test("a sibling reached by .. is outside", () => {
    expect(isInsideWorkingDir(cwd, join("src", "..", "..", "other", "x"))).toBe(false);
  });

  test("an absolute path under the working directory is inside", () => {
    expect(isInsideWorkingDir(cwd, resolve(cwd, "nested", "file.txt"))).toBe(true);
  });

  test("an absolute path outside the working directory is outside", () => {
    const outside = resolve(join("tmp-wd", "other", "secret.txt"));
    expect(isInsideWorkingDir(cwd, outside)).toBe(false);
  });

  // `..foo` is a legal filename, not a traversal. `rel.startsWith("..")` would misclassify it.
  test("a relative name that starts with dots but is not a parent traversal is inside", () => {
    expect(isInsideWorkingDir(cwd, "..foo")).toBe(true);
    expect(isInsideWorkingDir(cwd, join("src", `..foo${sep}bar`))).toBe(true);
  });

  test("case folding follows foldsCase: same path with different case is inside on win32/darwin", () => {
    const mixed = cwd.replace(/proj$/i, "PROJ");
    if (mixed === cwd) return;
    if (process.platform === "win32" || process.platform === "darwin") {
      expect(isInsideWorkingDir(mixed, join(cwd, "a.ts"))).toBe(true);
    } else {
      expect(isInsideWorkingDir(mixed, join(cwd, "a.ts"))).toBe(false);
    }
  });
});

describe("pathLocation", () => {
  test("names the two locations the policy table consumes", () => {
    expect(pathLocation(cwd, "a.ts")).toBe("inside");
    expect(pathLocation(cwd, join("..", "x"))).toBe("outside");
  });
});

describe("locationForCall", () => {
  test("a path-bearing tool with a nested relative path is inside", () => {
    expect(locationForCall(cwd, "read_file", { path: join("src", "a.ts") })).toBe("inside");
    expect(locationForCall(cwd, "grep", { path: ".", pattern: "x" })).toBe("inside");
    expect(locationForCall(cwd, "glob", { path: cwd, pattern: "*" })).toBe("inside");
    expect(locationForCall(cwd, "write_file", { path: "out.txt", content: "x" })).toBe("inside");
  });

  test("a path-bearing tool with a parent traversal or absolute outsider is outside", () => {
    expect(locationForCall(cwd, "read_file", { path: join("..", "secret") })).toBe("outside");
    expect(locationForCall(cwd, "grep", { path: "/etc", pattern: "x" })).toBe("outside");
  });

  test("a path-bearing tool with a missing or non-string path is outside", () => {
    expect(locationForCall(cwd, "read_file", {})).toBe("outside");
    expect(locationForCall(cwd, "read_file", { path: 1 })).toBe("outside");
    expect(locationForCall(cwd, "read_file", null)).toBe("outside");
    expect(locationForCall(cwd, "write_file", "not-an-object")).toBe("outside");
  });

  test("an empty cwd on a path-bearing tool is outside", () => {
    expect(locationForCall("", "read_file", { path: "a.ts" })).toBe("outside");
  });

  test("edit, bash, and an MCP name never have a working-directory question", () => {
    expect(locationForCall(cwd, "edit", { content: "x", oldString: "a", newString: "b" })).toBe(
      "nopath",
    );
    expect(locationForCall(cwd, "bash", { command: "cat /etc/passwd" })).toBe("nopath");
    expect(
      locationForCall(cwd, "powershell", { command: "Get-Content C:\\Windows\\win.ini" }),
    ).toBe("nopath");
    expect(locationForCall(cwd, "mcp_exa_web_search", { path: "/etc/passwd" })).toBe("nopath");
  });
});
