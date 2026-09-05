import { describe, expect, test } from "bun:test";
import { join, resolve, sep } from "node:path";
import {
  isInsideWorkingDir,
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
