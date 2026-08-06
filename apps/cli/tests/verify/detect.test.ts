import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectCheckCommand } from "../../src/verify/detect";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "seri-verify-detect-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writePackage(dir: string, scripts: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts }));
}

// Walking to the root package.json instead is the cost decision this whole feature turns on: in
// this repo the root `typecheck` chains eight workspaces at 20.3 s, where `apps/cli`'s own is 3.6 s.
// A green test that resolved to the root would look identical and cost six times as much per write.
describe("detectCheckCommand", () => {
  test("picks the nearest package.json, not the outermost one", () => {
    writePackage(root, { typecheck: "tsc --noEmit --project everything" });
    const nested = join(root, "apps", "cli");
    writePackage(nested, { typecheck: "tsc --noEmit" });

    expect(detectCheckCommand(join(nested, "src", "a.ts"))).toEqual({ cwd: nested, script: "typecheck" });
  });

  test("falls back to lint when the nearest package.json has no typecheck script", () => {
    writePackage(root, { lint: "eslint ." });
    expect(detectCheckCommand(join(root, "a.ts"))).toEqual({ cwd: root, script: "lint" });
  });

  test("prefers typecheck over lint when both are present", () => {
    writePackage(root, { lint: "eslint .", typecheck: "tsc --noEmit" });
    expect(detectCheckCommand(join(root, "a.ts"))?.script).toBe("typecheck");
  });

  // Acceptance criterion 4's negative control: the fixture is asserted to genuinely lack both a
  // package.json of its own and any ancestor carrying one, so `null` is a real detection result
  // rather than a check that would have passed against any implementation at all.
  test("a project with no package.json anywhere up the tree yields null", () => {
    const file = join(root, "src", "a.ts");
    mkdirSync(dirname(file), { recursive: true });

    for (let dir = dirname(file); ; dir = dirname(dir)) {
      expect(existsSync(join(dir, "package.json"))).toBe(false);
      if (dirname(dir) === dir) break;
    }

    expect(detectCheckCommand(file)).toBeNull();
  });

  test("a package.json with neither typecheck nor lint yields null, and does not keep walking up", () => {
    writePackage(root, { typecheck: "tsc --noEmit" });
    const nested = join(root, "apps", "web");
    writePackage(nested, { build: "vite build" });

    expect(detectCheckCommand(join(nested, "a.ts"))).toBeNull();
  });

  // A half-written package.json is a normal state for a repo an agent is editing. Throwing here
  // would turn a cosmetic detection failure into a failed write.
  test("an unparseable package.json yields null rather than throwing", () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), "{ not json");
    expect(detectCheckCommand(join(root, "a.ts"))).toBeNull();
  });
});
