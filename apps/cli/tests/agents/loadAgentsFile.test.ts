import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAgentsFile, loadAgentsFile } from "../../src/agents/loadAgentsFile";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "seri-loadAgentsFile-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("findAgentsFile", () => {
  test("finds AGENTS.md directly in startDir", () => {
    const agentsPath = join(tmpRoot, "AGENTS.md");
    writeFileSync(agentsPath, "root instructions");

    expect(findAgentsFile(tmpRoot)).toBe(agentsPath);
  });

  test("finds the nearest AGENTS.md when a parent also has one", () => {
    writeFileSync(join(tmpRoot, "AGENTS.md"), "parent instructions");

    const nestedDir = join(tmpRoot, "nested");
    mkdirSync(nestedDir);
    const nestedAgentsPath = join(nestedDir, "AGENTS.md");
    writeFileSync(nestedAgentsPath, "nested instructions");

    expect(findAgentsFile(nestedDir)).toBe(nestedAgentsPath);
  });






  test("returns undefined when no AGENTS.md exists in a fresh temp dir", () => {
    expect(findAgentsFile(tmpRoot)).toBeUndefined();
  });
});

describe("loadAgentsFile", () => {
  test("returns the file's content when found", () => {
    writeFileSync(join(tmpRoot, "AGENTS.md"), "hello agents");

    expect(loadAgentsFile(tmpRoot)).toBe("hello agents");
  });

  test('returns "" when none exists', () => {
    expect(loadAgentsFile(tmpRoot)).toBe("");
  });
});
