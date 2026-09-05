import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlansDir } from "../../src/config/paths";
import { slugFromTitle, unlinkPlanFile, writePlanFile } from "../../src/plan/files";

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seri-plan-files-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("slugFromTitle", () => {
  test("lowercases and hyphenates", () => {
    expect(slugFromTitle("Hello World")).toBe("hello-world");
  });

  test("an empty or punctuation-only title becomes plan", () => {
    expect(slugFromTitle("")).toBe("plan");
    expect(slugFromTitle("!!!")).toBe("plan");
  });

  test("truncates to 60 characters", () => {
    expect(slugFromTitle("a".repeat(80)).length).toBe(60);
  });
});

describe("writePlanFile", () => {
  test("writes under getPlansDir(configDir), not the cwd", () => {
    const configDir = makeDir();
    const written = writePlanFile(configDir, "Auth rewrite", "Do the thing.");
    expect(written.path).toBe(join(getPlansDir(configDir), "auth-rewrite.md"));
    expect(existsSync(written.path)).toBe(true);
    expect(readFileSync(written.path, "utf8")).toBe("# Auth rewrite\n\nDo the thing.\n");
  });

  test("does not prepend a heading when markdown already starts with one", () => {
    const configDir = makeDir();
    const written = writePlanFile(configDir, "Title", "# Already headed\n\nbody\n");
    expect(readFileSync(written.path, "utf8")).toBe("# Already headed\n\nbody\n");
  });

  test("a second write with the same title gets a unique path", () => {
    const configDir = makeDir();
    const first = writePlanFile(configDir, "Same", "one");
    const second = writePlanFile(configDir, "Same", "two");
    expect(first.path).not.toBe(second.path);
    expect(second.path).toBe(join(getPlansDir(configDir), "same-2.md"));
    expect(readFileSync(first.path, "utf8")).toContain("one");
    expect(readFileSync(second.path, "utf8")).toContain("two");
  });
});

describe("unlinkPlanFile", () => {
  test("unlinks a file inside the plans directory", () => {
    const configDir = makeDir();
    const written = writePlanFile(configDir, "Temp", "body");
    unlinkPlanFile(written.path, configDir);
    expect(existsSync(written.path)).toBe(false);
  });

  test("refuses a path outside the plans directory", () => {
    const configDir = makeDir();
    const outsider = join(makeDir(), "not-a-plan.md");
    writeFileSync(outsider, "keep me\n");
    unlinkPlanFile(outsider, configDir);
    expect(existsSync(outsider)).toBe(true);
    expect(readFileSync(outsider, "utf8")).toBe("keep me\n");
  });
});
