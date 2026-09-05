import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolFingerprint } from "../../src/mcp/registry";
import type { McpToolInfo } from "../../src/mcp/types";
import { mcpGrantKey } from "../../src/mcp/types";
import {
  effectiveTools,
  forgetGrant,
  isPersistableTool,
  loadAutoModeOnBlock,
  loadGrants,
  PERSISTABLE_TOOL_NAMES,
  permissionsPath,
  projectKey,
  rememberGrant,
} from "../../src/permissions/store";
import { WRITE_TOOL_NAMES } from "../../src/provider/tools";

function tool(overrides: Partial<McpToolInfo> = {}): McpToolInfo {
  return {
    name: "web_search",
    toolName: "mcp_exa_web_search",
    description: "Search the web.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    ...overrides,
  };
}

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
    writeFileSync(
      permissionsPath(dir),
      `global: []\nprojects:\n  '${projectKey("/w")}':\n    - bash\n`,
    );
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
    writeFileSync(
      permissionsPath(dir),
      `global: [edit]\nprojects:\n  '${projectKey("/w")}':\n    - edit\n`,
    );

    expect(forgetGrant(dir, "/w", "edit", "both")).toEqual({ global: true, project: true });
    expect(forgetGrant(dir, "/w", "edit", "both")).toEqual({ global: false, project: false });
    expect(loadGrants(dir, "/w")).toEqual({ global: [], project: [], otherProjects: 0 });
  });

  // scope: "project" leaves an existing global grant of the same tool untouched — the TUI's
  // /permissions panel only ever shows a project-tier grant as removable (decidePermissionsOpen
  // collapses a tool present in both tiers into a single "persisted" row), so its removal must not
  // silently take the invisible global pre-approval with it.
  test("forgetGrant with scope 'project' clears only the project section, leaving global intact", () => {
    writeFileSync(
      permissionsPath(dir),
      `global: [edit]\nprojects:\n  '${projectKey("/w")}':\n    - edit\n`,
    );

    expect(forgetGrant(dir, "/w", "edit", "project")).toEqual({ global: false, project: true });
    expect(loadGrants(dir, "/w")).toEqual({ global: ["edit"], project: [], otherProjects: 0 });
  });

  // Bug 1: forgetGrant must warn on a malformed/unreadable store instead of silently reporting
  // "nothing removed" indistinguishably from a genuinely empty store.
  test("forgetGrant warns on a malformed store instead of silently reporting nothing removed", () => {
    writeFileSync(permissionsPath(dir), ":::not yaml:::");

    const warnings: string[] = [];
    expect(forgetGrant(dir, "/w", "write_file", "both", (m) => warnings.push(m))).toEqual({
      global: false,
      project: false,
    });
    expect(warnings).toHaveLength(1);
  });

  // Bug 2, part 1: an emptied project entry must be pruned, not left as `key: []` — an orphaned
  // empty list would otherwise count toward otherProjects forever.
  test("forgetGrant deletes the project's key once its list is empty, instead of leaving []", () => {
    rememberGrant(dir, "/w", "write_file");

    expect(forgetGrant(dir, "/w", "write_file", "both")).toEqual({ global: false, project: true });

    expect(readFileSync(permissionsPath(dir), "utf8")).not.toContain(projectKey("/w"));
  });

  // The otherProjects overcount this fixes: grant-then-fully-revoke in project B must not leave
  // project A seeing a phantom "other project" forever.
  test("otherProjects does not count a project whose only grant was fully revoked", () => {
    rememberGrant(dir, "/b", "write_file");
    forgetGrant(dir, "/b", "write_file", "both");

    expect(loadGrants(dir, "/a").otherProjects).toBe(0);
  });

  // 11. Malformed YAML degrades, and is not overwritten.
  test("malformed content degrades to empty, warns, and rememberGrant leaves the bytes untouched", () => {
    writeFileSync(permissionsPath(dir), ":::not yaml:::");
    const before = readFileSync(permissionsPath(dir), "utf8");

    const warnings: string[] = [];
    expect(loadGrants(dir, "/w", (m) => warnings.push(m))).toEqual({
      global: [],
      project: [],
      otherProjects: 0,
    });
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

  // A path that exists but cannot be READ, not merely parsed — existsSync is true for both a
  // permission-denied file and a directory sitting at the same path, so it cannot be relied on to
  // predict whether readFileSync will succeed. A directory reproduces this on every platform
  // (EISDIR on POSIX and on Windows alike), unlike a chmod-based approach, which only works on
  // POSIX. Not skipIf(win32).
  test("a directory at the store's path degrades to empty instead of throwing", () => {
    mkdirSync(permissionsPath(dir));

    const warnings: string[] = [];
    expect(loadGrants(dir, "/w", (m) => warnings.push(m))).toEqual({
      global: [],
      project: [],
      otherProjects: 0,
    });
    expect(warnings).toHaveLength(1);

    expect(rememberGrant(dir, "/w", "write_file", (m) => warnings.push(m))).toBe(false);
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

  // A built-in name with a fingerprint is refused — the digest would mean nothing, since there is
  // no third-party contract to pin it to.
  test("a built-in name with a fingerprint is refused, and nothing is created", () => {
    expect(rememberGrant(dir, "/w", "write_file", undefined, toolFingerprint(tool()))).toBe(false);
    expect(existsSync(permissionsPath(dir))).toBe(false);
  });

  // NEGATIVE CONTROL 1: an mcp_ name with no fingerprint must be refused — an unbound MCP grant is
  // exactly the rug pull this design exists to stop. Made rememberGrant accept it with no
  // fingerprint (dropped the `if (fingerprint === undefined) return false` branch): this test went
  // red, failing on `expect(false).toBe(true)` — rememberGrant returned true and wrote the entry.
  test("an mcp_ name with no fingerprint is refused, and nothing is created", () => {
    expect(rememberGrant(dir, "/w", "mcp_exa_web_search")).toBe(false);
    expect(existsSync(permissionsPath(dir))).toBe(false);
  });

  // bash and powershell stay refused even with a fingerprint attached — a fingerprint does not
  // launder a shell name into a persistable one.
  test.each(["bash", "powershell"])(
    "%s is refused even with a fingerprint, and nothing is created",
    (name) => {
      expect(rememberGrant(dir, "/w", name, undefined, toolFingerprint(tool()))).toBe(false);
      expect(existsSync(permissionsPath(dir))).toBe(false);
    },
  );

  // An mcp_ name with a fingerprint stores mcpGrantKey(tool, fingerprint), and it round-trips
  // through loadGrants.
  test("an mcp_ name with a fingerprint stores the composed grant key", () => {
    const fingerprint = toolFingerprint(tool());
    expect(rememberGrant(dir, "/w", "mcp_exa_web_search", undefined, fingerprint)).toBe(true);
    expect(loadGrants(dir, "/w").project).toEqual([mcpGrantKey("mcp_exa_web_search", fingerprint)]);
  });

  // Re-granting the same MCP tool after its catalog changed REPLACES the stale entry rather than
  // appending a second one for the same tool — two entries would let the old contract keep
  // authorising the call.
  test("re-granting an mcp_ tool under a new fingerprint replaces the stale entry", () => {
    const before = toolFingerprint(tool({ description: "Search the web." }));
    const after = toolFingerprint(tool({ description: "Search the web, differently." }));

    expect(rememberGrant(dir, "/w", "mcp_exa_web_search", undefined, before)).toBe(true);
    expect(rememberGrant(dir, "/w", "mcp_exa_web_search", undefined, after)).toBe(true);

    const grants = loadGrants(dir, "/w");
    expect(grants.project).toEqual([mcpGrantKey("mcp_exa_web_search", after)]);
    expect(grants.project).not.toContain(mcpGrantKey("mcp_exa_web_search", before));
  });

  // Re-granting the exact same tool under the exact same fingerprint is a true no-op: nothing is
  // rewritten, and no second entry appears.
  test("re-granting an mcp_ tool under the same fingerprint is a no-op", () => {
    const fingerprint = toolFingerprint(tool());
    expect(rememberGrant(dir, "/w", "mcp_exa_web_search", undefined, fingerprint)).toBe(true);
    expect(rememberGrant(dir, "/w", "mcp_exa_web_search", undefined, fingerprint)).toBe(false);
    expect(loadGrants(dir, "/w").project).toEqual([mcpGrantKey("mcp_exa_web_search", fingerprint)]);
  });

  // A stale entry for the same tool can live in the GLOBAL tier by hand — rememberGrant itself
  // never writes there, but the template's own header invites editing it. Re-granting must still
  // replace it rather than leave a stale global digest sitting alongside a fresh project one,
  // which would let the old contract keep authorising the call. Asserted against the reparsed
  // file, not the in-memory document, so a fix that only mutates the doc object without writing
  // it back would not be mistaken for correct.
  test("re-granting an mcp_ tool removes a stale entry that lives in the global tier", () => {
    const before = toolFingerprint(tool({ description: "Search the web." }));
    const after = toolFingerprint(tool({ description: "Search the web, differently." }));
    writeFileSync(
      permissionsPath(dir),
      `global:\n  - ${mcpGrantKey("mcp_exa_web_search", before)}\nprojects: {}\n`,
    );

    expect(rememberGrant(dir, "/w", "mcp_exa_web_search", undefined, after)).toBe(true);

    const raw = readFileSync(permissionsPath(dir), "utf8");
    const occurrences = (raw.match(/mcp_exa_web_search@/g) ?? []).length;
    expect(occurrences).toBe(1);

    const grants = loadGrants(dir, "/w");
    expect(effectiveTools(grants)).toEqual([mcpGrantKey("mcp_exa_web_search", after)]);
  });

  // The built-in path must be unaffected by the global-tier lookup added above: a global grant of
  // write_file still makes a project re-grant a no-op, exactly as before.
  test("a global write_file entry still makes a project re-grant a no-op", () => {
    writeFileSync(permissionsPath(dir), "global: [write_file]\nprojects: {}\n");
    const before = readFileSync(permissionsPath(dir), "utf8");

    expect(rememberGrant(dir, "/w", "write_file")).toBe(false);

    expect(readFileSync(permissionsPath(dir), "utf8")).toBe(before);
    expect(loadGrants(dir, "/w")).toEqual({
      global: ["write_file"],
      project: [],
      otherProjects: 0,
    });
  });

  // A hand-written entry with a malformed digest is dropped on read, with a warning — the same
  // hand-edit hole as a bash entry, for the MCP shape.
  test("a hand-written mcp entry with a malformed digest is dropped on read and warned about", () => {
    writeFileSync(
      permissionsPath(dir),
      `global: []\nprojects:\n  '${projectKey("/w")}':\n    - mcp_exa_web_search@short\n`,
    );
    const warnings: string[] = [];
    const grants = loadGrants(dir, "/w", (m) => warnings.push(m));
    expect(grants.project).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("mcp_exa_web_search@short");
  });

  // A well-shaped mcp grant key round-trips through loadGrants unmolested.
  test("a hand-written, well-shaped mcp entry round-trips through loadGrants", () => {
    writeFileSync(
      permissionsPath(dir),
      `global: []\nprojects:\n  '${projectKey("/w")}':\n    - mcp_exa_web_search@a1b2c3d4e5f6\n`,
    );
    expect(loadGrants(dir, "/w").project).toEqual(["mcp_exa_web_search@a1b2c3d4e5f6"]);
  });

  // isPersistableTool is the single "may this be remembered at all" answer both approval-prompt
  // call sites in cli.ts and rememberGrant's own whether-check now read — previously written
  // three times independently, which is what let one copy drift without a test catching it until
  // a negative control against each site individually. One function, tested here directly.
  test("isPersistableTool: true for write_file, edit, and an mcp_ name", () => {
    expect(isPersistableTool("write_file")).toBe(true);
    expect(isPersistableTool("edit")).toBe(true);
    expect(isPersistableTool("mcp_exa_web_search")).toBe(true);
  });

  test("isPersistableTool: false for bash, powershell, and an invented name", () => {
    expect(isPersistableTool("bash")).toBe(false);
    expect(isPersistableTool("powershell")).toBe(false);
    expect(isPersistableTool("frobnicate")).toBe(false);
  });

  // The invariant that actually matters: whatever isPersistableTool says may be offered at the
  // prompt, rememberGrant must actually accept — otherwise a user answers "[a]lways" to a question
  // the store silently discards, with no error and no saved grant. Seen red first: with
  // isPersistableTool changed to return false for an mcp_ name, this fails at the assertion below
  // (isPersistableTool("mcp_exa_web_search") is false, so the loop's own `if` never reaches
  // rememberGrant for it at all — the missing offer is the bug this test exists to catch).
  test("every name isPersistableTool allows, rememberGrant actually persists", () => {
    for (const name of ["write_file", "edit", "mcp_exa_web_search"]) {
      expect(isPersistableTool(name)).toBe(true);
      const fingerprint = name.startsWith("mcp_")
        ? toolFingerprint(tool({ toolName: name }))
        : undefined;
      expect(rememberGrant(dir, "/w", name, undefined, fingerprint)).toBe(true);
    }
  });
});

describe("loadAutoModeOnBlock", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seri-permissions-autoblock-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a missing file is deny and is not created", () => {
    expect(loadAutoModeOnBlock(dir)).toBe("deny");
    expect(existsSync(permissionsPath(dir))).toBe(false);
  });

  test("a grants-only file is deny", () => {
    writeFileSync(permissionsPath(dir), "global: []\nprojects: {}\n");
    expect(loadAutoModeOnBlock(dir)).toBe("deny");
  });

  test("ask is honoured when the rest of the file is well-formed", () => {
    writeFileSync(permissionsPath(dir), "global: []\nprojects: {}\nautoModeOnBlock: ask\n");
    expect(loadAutoModeOnBlock(dir)).toBe("ask");
  });

  test("an extra YAML key does not make the file malformed", () => {
    writeFileSync(
      permissionsPath(dir),
      "global: []\nprojects: {}\nunrelated: 1\nautoModeOnBlock: ask\n",
    );
    expect(loadAutoModeOnBlock(dir)).toBe("ask");
  });

  test("an unknown value warns and is deny", () => {
    writeFileSync(permissionsPath(dir), "global: []\nprojects: {}\nautoModeOnBlock: prompt\n");
    const warnings: string[] = [];
    expect(loadAutoModeOnBlock(dir, (m) => warnings.push(m))).toBe("deny");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("autoModeOnBlock");
    expect(warnings[0]).toContain("prompt");
  });

  test("a malformed file is deny without a dedicated warning of its own", () => {
    writeFileSync(permissionsPath(dir), ":::not yaml:::");
    const warnings: string[] = [];
    expect(loadAutoModeOnBlock(dir, (m) => warnings.push(m))).toBe("deny");
    expect(warnings).toEqual([]);
  });
});
