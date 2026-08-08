import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effectiveTools,
  forgetGrant,
  loadGrants,
  PERSISTABLE_TOOL_NAMES,
  permissionsPath,
  projectKey,
  rememberGrant,
} from "../../src/permissions/store";
import { WRITE_TOOL_NAMES } from "../../src/provider/tools";

describe("permissions store", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seri-permissions-store-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // 1. A missing file reads empty and is not created.
  test("a missing file reads empty and is not created", () => {
    expect(loadGrants(dir, "/w")).toEqual({ global: [], project: [], otherProjects: 0 });
    expect(existsSync(permissionsPath(dir))).toBe(false);
  });

  // 2. Write-then-read-back at module level.
  test("a grant written by rememberGrant is visible to a fresh loadGrants call", () => {
    expect(rememberGrant(dir, "/w", "write_file")).toBe(true);
    expect(loadGrants(dir, "/w").project).toEqual(["write_file"]);
  });

  // 3. bash and powershell are refused on write.
  test.each(["bash", "powershell"])("%s is refused on write, and nothing is created", (tool) => {
    expect(rememberGrant(dir, "/w", tool)).toBe(false);
    expect(existsSync(permissionsPath(dir))).toBe(false);
  });

  // 4. bash is refused on read — the hand-edit hole, and the most important case in the file.
  test("a hand-written bash entry is dropped on read and warned about exactly once", () => {
    writeFileSync(permissionsPath(dir), `global: []\nprojects:\n  '${projectKey("/w")}':\n    - bash\n`);
    const warnings: string[] = [];
    const grants = loadGrants(dir, "/w", (m) => warnings.push(m));
    expect(grants.project).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("bash");
    expect(warnings[0]).toContain(permissionsPath(dir));
  });

  // 5. Comments survive a rewrite — the entire justification for the yaml dependency.
  test("a rewrite preserves an existing hand-written comment and both entries", () => {
    rememberGrant(dir, "/w", "write_file");
    const withComment = readFileSync(permissionsPath(dir), "utf8").replace(
      "- write_file",
      "- write_file # needed because CI writes here",
    );
    writeFileSync(permissionsPath(dir), withComment);

    rememberGrant(dir, "/w", "edit");

    const final = readFileSync(permissionsPath(dir), "utf8");
    expect(final).toContain("# needed because CI writes here");
    expect(final).toContain("write_file");
    expect(final).toContain("edit");
  });

  // 6. Project isolation.
  test("a grant under one project does not leak into another, which sees itself counted as other", () => {
    rememberGrant(dir, "/a", "write_file");
    const grants = loadGrants(dir, "/b");
    expect(grants.project).toEqual([]);
    expect(grants.otherProjects).toBe(1);
  });

  // 7. Case folding matches checkpointStoreDir's rule.
  test("case folding follows checkpointStoreDir's platform rule", () => {
    rememberGrant(dir, "C:\\Proj", "write_file");
    const grants = loadGrants(dir, "c:\\proj");
    if (process.platform === "win32" || process.platform === "darwin") {
      expect(grants.project).toEqual(["write_file"]);
    } else {
      expect(grants.project).toEqual([]);
    }
  });

  // 8. A Windows-shaped key round-trips, on every platform.
  test("a drive-letter, backslash-shaped key round-trips", () => {
    rememberGrant(dir, "C:\\Users\\me\\code\\app", "write_file");
    expect(loadGrants(dir, "C:\\Users\\me\\code\\app").project).toEqual(["write_file"]);
  });

  // 9. A hand-written global entry applies to every project.
  test("a hand-written global entry applies to every project", () => {
    writeFileSync(permissionsPath(dir), "global: [edit]\nprojects: {}\n");
    const grants = loadGrants(dir, "/anything");
    expect(grants.global).toEqual(["edit"]);
    expect(effectiveTools(grants)).toContain("edit");
  });

  // 10. forgetGrant clears both sections and is idempotent.
  test("forgetGrant clears both the global and project sections, and is idempotent", () => {
    writeFileSync(permissionsPath(dir), `global: [edit]\nprojects:\n  '${projectKey("/w")}':\n    - edit\n`);

    expect(forgetGrant(dir, "/w", "edit")).toEqual({ global: true, project: true });
    expect(forgetGrant(dir, "/w", "edit")).toEqual({ global: false, project: false });
    expect(loadGrants(dir, "/w")).toEqual({ global: [], project: [], otherProjects: 0 });
  });

  // 11. Malformed YAML degrades, and is not overwritten.
  test("malformed content degrades to empty, warns, and rememberGrant leaves the bytes untouched", () => {
    writeFileSync(permissionsPath(dir), ":::not yaml:::");
    const before = readFileSync(permissionsPath(dir), "utf8");

    const warnings: string[] = [];
    expect(loadGrants(dir, "/w", (m) => warnings.push(m))).toEqual({ global: [], project: [], otherProjects: 0 });
    expect(warnings).toHaveLength(1);

    expect(rememberGrant(dir, "/w", "write_file", (m) => warnings.push(m))).toBe(false);
    expect(readFileSync(permissionsPath(dir), "utf8")).toBe(before);
  });

  test("a well-formed but wrong-shaped file also degrades to empty, without throwing", () => {
    const raw = 'global: []\nprojects: "hello"\n';
    writeFileSync(permissionsPath(dir), raw);

    expect(loadGrants(dir, "/w")).toEqual({ global: [], project: [], otherProjects: 0 });
    // The half that pins the shape check specifically: without it, rememberGrant would silently
    // replace the malformed `projects: "hello"` with a fresh map instead of refusing to touch it.
    expect(rememberGrant(dir, "/w", "write_file")).toBe(false);
    expect(readFileSync(permissionsPath(dir), "utf8")).toBe(raw);
  });

  // 12. Permissions and the constant.
  test.skipIf(process.platform === "win32")("the written file and directory are owner-only", () => {
    rememberGrant(dir, "/w", "write_file");
    expect(statSync(permissionsPath(dir)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  // The hard constraint, pinned as a test: no accumulation of grants this store can hold ever
  // reproduces --dangerously-skip-permissions, because bash/powershell can never be in it.
  test("PERSISTABLE_TOOL_NAMES is a subset of WRITE_TOOL_NAMES and excludes bash and powershell", () => {
    for (const name of PERSISTABLE_TOOL_NAMES) expect(WRITE_TOOL_NAMES).toContain(name);
    expect(PERSISTABLE_TOOL_NAMES).not.toContain("bash");
    expect(PERSISTABLE_TOOL_NAMES).not.toContain("powershell");
  });
});
