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
import { denialBlocks } from "../../src/gate/gate";
import { toolFingerprint } from "../../src/mcp/registry";
import type { McpToolInfo } from "../../src/mcp/types";
import { mcpGrantKey } from "../../src/mcp/types";
import {
  effectiveTools,
  forgetGrant,
  isPersistableTool,
  loadAutoModeOnBlock,
  loadDenials,
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


  test("a missing file reads empty and is not created", () => {
    expect(loadGrants(dir, "/w")).toEqual({ global: [], project: [], otherProjects: 0 });
    expect(existsSync(permissionsPath(dir))).toBe(false);
  });


  test("a grant written by rememberGrant is visible to a fresh loadGrants call", () => {
    expect(rememberGrant(dir, "/w", "write_file")).toBe(true);
    expect(loadGrants(dir, "/w").project).toEqual(["write_file"]);
  });


  test.each(["bash", "powershell"])("%s is refused on write, and nothing is created", (tool) => {
    expect(rememberGrant(dir, "/w", tool)).toBe(false);
    expect(existsSync(permissionsPath(dir))).toBe(false);
  });


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


  test("a grant under one project does not leak into another, which sees itself counted as other", () => {
    rememberGrant(dir, "/a", "write_file");
    const grants = loadGrants(dir, "/b");
    expect(grants.project).toEqual([]);
    expect(grants.otherProjects).toBe(1);
  });


  test("case folding follows checkpointStoreDir's platform rule", () => {
    rememberGrant(dir, "C:\\Proj", "write_file");
    const grants = loadGrants(dir, "c:\\proj");
    if (process.platform === "win32" || process.platform === "darwin") {
      expect(grants.project).toEqual(["write_file"]);
    } else {
      expect(grants.project).toEqual([]);
    }
  });


  test("a drive-letter, backslash-shaped key round-trips", () => {
    rememberGrant(dir, "C:\\Users\\me\\code\\app", "write_file");
    expect(loadGrants(dir, "C:\\Users\\me\\code\\app").project).toEqual(["write_file"]);
  });


  test("a hand-written global entry applies to every project", () => {
    writeFileSync(permissionsPath(dir), "global: [edit]\nprojects: {}\n");
    const grants = loadGrants(dir, "/anything");
    expect(grants.global).toEqual(["edit"]);
    expect(effectiveTools(grants)).toContain("edit");
  });


  test("forgetGrant clears both the global and project sections, and is idempotent", () => {
    writeFileSync(
      permissionsPath(dir),
      `global: [edit]\nprojects:\n  '${projectKey("/w")}':\n    - edit\n`,
    );

    expect(forgetGrant(dir, "/w", "edit", "both")).toEqual({ global: true, project: true });
    expect(forgetGrant(dir, "/w", "edit", "both")).toEqual({ global: false, project: false });
    expect(loadGrants(dir, "/w")).toEqual({ global: [], project: [], otherProjects: 0 });
  });





  test("forgetGrant with scope 'project' clears only the project section, leaving global intact", () => {
    writeFileSync(
      permissionsPath(dir),
      `global: [edit]\nprojects:\n  '${projectKey("/w")}':\n    - edit\n`,
    );

    expect(forgetGrant(dir, "/w", "edit", "project")).toEqual({ global: false, project: true });
    expect(loadGrants(dir, "/w")).toEqual({ global: ["edit"], project: [], otherProjects: 0 });
  });



  test("forgetGrant warns on a malformed store instead of silently reporting nothing removed", () => {
    writeFileSync(permissionsPath(dir), ":::not yaml:::");

    const warnings: string[] = [];
    expect(forgetGrant(dir, "/w", "write_file", "both", (m) => warnings.push(m))).toEqual({
      global: false,
      project: false,
    });
    expect(warnings).toHaveLength(1);
  });



  test("forgetGrant deletes the project's key once its list is empty, instead of leaving []", () => {
    rememberGrant(dir, "/w", "write_file");

    expect(forgetGrant(dir, "/w", "write_file", "both")).toEqual({ global: false, project: true });

    expect(readFileSync(permissionsPath(dir), "utf8")).not.toContain(projectKey("/w"));
  });



  test("otherProjects does not count a project whose only grant was fully revoked", () => {
    rememberGrant(dir, "/b", "write_file");
    forgetGrant(dir, "/b", "write_file", "both");

    expect(loadGrants(dir, "/a").otherProjects).toBe(0);
  });


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


    expect(rememberGrant(dir, "/w", "write_file")).toBe(false);
    expect(readFileSync(permissionsPath(dir), "utf8")).toBe(raw);
  });






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


  test.skipIf(process.platform === "win32")("the written file and directory are owner-only", () => {
    rememberGrant(dir, "/w", "write_file");
    expect(statSync(permissionsPath(dir)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });



  test("PERSISTABLE_TOOL_NAMES is a subset of WRITE_TOOL_NAMES and excludes bash and powershell", () => {
    for (const name of PERSISTABLE_TOOL_NAMES) expect(WRITE_TOOL_NAMES).toContain(name);
    expect(PERSISTABLE_TOOL_NAMES).not.toContain("bash");
    expect(PERSISTABLE_TOOL_NAMES).not.toContain("powershell");
  });



  test("a built-in name with a fingerprint is refused, and nothing is created", () => {
    expect(rememberGrant(dir, "/w", "write_file", undefined, toolFingerprint(tool()))).toBe(false);
    expect(existsSync(permissionsPath(dir))).toBe(false);
  });





  test("an mcp_ name with no fingerprint is refused, and nothing is created", () => {
    expect(rememberGrant(dir, "/w", "mcp_exa_web_search")).toBe(false);
    expect(existsSync(permissionsPath(dir))).toBe(false);
  });



  test.each(["bash", "powershell"])(
    "%s is refused even with a fingerprint, and nothing is created",
    (name) => {
      expect(rememberGrant(dir, "/w", name, undefined, toolFingerprint(tool()))).toBe(false);
      expect(existsSync(permissionsPath(dir))).toBe(false);
    },
  );



  test("an mcp_ name with a fingerprint stores the composed grant key", () => {
    const fingerprint = toolFingerprint(tool());
    expect(rememberGrant(dir, "/w", "mcp_exa_web_search", undefined, fingerprint)).toBe(true);
    expect(loadGrants(dir, "/w").project).toEqual([mcpGrantKey("mcp_exa_web_search", fingerprint)]);
  });




  test("re-granting an mcp_ tool under a new fingerprint replaces the stale entry", () => {
    const before = toolFingerprint(tool({ description: "Search the web." }));
    const after = toolFingerprint(tool({ description: "Search the web, differently." }));

    expect(rememberGrant(dir, "/w", "mcp_exa_web_search", undefined, before)).toBe(true);
    expect(rememberGrant(dir, "/w", "mcp_exa_web_search", undefined, after)).toBe(true);

    const grants = loadGrants(dir, "/w");
    expect(grants.project).toEqual([mcpGrantKey("mcp_exa_web_search", after)]);
    expect(grants.project).not.toContain(mcpGrantKey("mcp_exa_web_search", before));
  });



  test("re-granting an mcp_ tool under the same fingerprint is a no-op", () => {
    const fingerprint = toolFingerprint(tool());
    expect(rememberGrant(dir, "/w", "mcp_exa_web_search", undefined, fingerprint)).toBe(true);
    expect(rememberGrant(dir, "/w", "mcp_exa_web_search", undefined, fingerprint)).toBe(false);
    expect(loadGrants(dir, "/w").project).toEqual([mcpGrantKey("mcp_exa_web_search", fingerprint)]);
  });







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


  test("a hand-written, well-shaped mcp entry round-trips through loadGrants", () => {
    writeFileSync(
      permissionsPath(dir),
      `global: []\nprojects:\n  '${projectKey("/w")}':\n    - mcp_exa_web_search@a1b2c3d4e5f6\n`,
    );
    expect(loadGrants(dir, "/w").project).toEqual(["mcp_exa_web_search@a1b2c3d4e5f6"]);
  });





  test("isPersistableTool: true for write_file, edit, and an mcp_ name", () => {
    expect(isPersistableTool("write_file")).toBe(true);
    expect(isPersistableTool("edit")).toBe(true);
    expect(isPersistableTool("mcp_exa_web_search")).toBe(true);
  });

  test("a missing file yields no path denials and is not created", () => {
    expect(loadDenials(dir)).toEqual([]);
    expect(existsSync(permissionsPath(dir))).toBe(false);
  });

  test("a deny-only file still loads denials, even without global or projects", () => {
    writeFileSync(permissionsPath(dir), "deny:\n  - read_file(.env)\n");
    expect(loadDenials(dir)).toEqual([{ tool: "read_file", pattern: ".env" }]);
  });

  test("a deny for an unknown or path-less tool is skipped and warned about, without dropping the rest", () => {
    writeFileSync(
      permissionsPath(dir),
      "global: []\nprojects: {}\ndeny:\n  - read_file(.env)\n  - reed_file(.env)\n  - bash(rm -rf /)\n  - glob(/secret/**)\n",
    );
    const warnings: string[] = [];
    expect(loadDenials(dir, (m) => warnings.push(m))).toEqual([
      { tool: "read_file", pattern: ".env" },
      { tool: "glob", pattern: "/secret/**" },
    ]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("reed_file(.env)");
    expect(warnings[1]).toContain("bash(rm -rf /)");
  });

  test("a missing deny key yields no path denials and still loads grants", () => {
    writeFileSync(permissionsPath(dir), "global: [edit]\nprojects: {}\n");
    expect(loadDenials(dir)).toEqual([]);
    expect(loadGrants(dir, "/w").global).toEqual(["edit"]);
  });

  test("well-formed deny entries parse as PathDenial values", () => {
    writeFileSync(
      permissionsPath(dir),
      "global: []\nprojects: {}\ndeny:\n  - glob(/secret/**)\n  - read_file(.env)\n  - grep(/tmp/seri-does-not-exist/**)\n",
    );
    expect(loadDenials(dir)).toEqual([
      { tool: "glob", pattern: "/secret/**" },
      { tool: "read_file", pattern: ".env" },
      { tool: "grep", pattern: "/tmp/seri-does-not-exist/**" },
    ]);
  });

  test("a badly shaped deny entry is skipped and warned about, without dropping the rest", () => {
    writeFileSync(
      permissionsPath(dir),
      "global: []\nprojects: {}\ndeny:\n  - glob(/secret/**)\n  - not-a-denial\n  - glob()\n",
    );
    const warnings: string[] = [];
    expect(loadDenials(dir, (m) => warnings.push(m))).toEqual([
      { tool: "glob", pattern: "/secret/**" },
    ]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("not-a-denial");
    expect(warnings[1]).toContain("glob()");
  });

  test("a wrong-type deny key is ignored and warned about, without marking the store malformed", () => {
    writeFileSync(permissionsPath(dir), 'global: [edit]\nprojects: {}\ndeny: "glob(/secret/**)"\n');
    const warnings: string[] = [];
    expect(loadDenials(dir, (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("expected a list");
    expect(loadGrants(dir, "/w").global).toEqual(["edit"]);
  });

  test("object-form and numeric deny entries warn naming deny[index] and leave sibling string denials in place", () => {
    writeFileSync(
      permissionsPath(dir),
      "global: [edit]\nprojects: {}\ndeny:\n  - read_file(.env)\n  - path: /tmp/secret\n  - 42\n  - glob(/secret/**)\n  - true\n",
    );
    const warnings: string[] = [];
    expect(loadDenials(dir, (m) => warnings.push(m))).toEqual([
      { tool: "read_file", pattern: ".env" },
      { tool: "glob", pattern: "/secret/**" },
    ]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("deny[1]");
    expect(warnings[0]).toContain("object");
    expect(warnings[1]).toContain("deny[2]");
    expect(warnings[1]).toContain("number");
    expect(warnings[2]).toContain("deny[4]");
    expect(warnings[2]).toContain("boolean");
    expect(loadGrants(dir, "/w").global).toEqual(["edit"]);
    expect(denialBlocks(loadDenials(dir), "read_file", { path: join(dir, ".env") }, dir)).toBe(
      true,
    );
    expect(denialBlocks(loadDenials(dir), "glob", { path: "/secret/keys" })).toBe(true);
  });

  test("a sandbox key in permissions.yaml does not drop path denials", () => {
    writeFileSync(
      permissionsPath(dir),
      "global: []\nprojects: {}\nsandbox:\n  filesystem:\n    denyRead:\n      - path: /tmp/secret\ndeny:\n  - read_file(.env)\n",
    );
    const warnings: string[] = [];
    expect(loadDenials(dir, (m) => warnings.push(m))).toEqual([
      { tool: "read_file", pattern: ".env" },
    ]);
    expect(warnings).toEqual([]);
  });

  test("an object-form deny entry is not honoured as a path denial", () => {
    writeFileSync(permissionsPath(dir), "global: []\nprojects: {}\ndeny:\n  - path: .env\n");
    const warnings: string[] = [];
    expect(loadDenials(dir, (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("deny[0]");
  });

  test("rememberGrant preserves an existing deny list", () => {
    writeFileSync(permissionsPath(dir), "global: []\nprojects: {}\ndeny:\n  - glob(/secret/**)\n");
    expect(rememberGrant(dir, "/w", "write_file")).toBe(true);
    expect(loadDenials(dir)).toEqual([{ tool: "glob", pattern: "/secret/**" }]);
    expect(readFileSync(permissionsPath(dir), "utf8")).toContain("glob(/secret/**)");
  });

  test("isPersistableTool: false for bash, powershell, and an invented name", () => {
    expect(isPersistableTool("bash")).toBe(false);
    expect(isPersistableTool("powershell")).toBe(false);
    expect(isPersistableTool("frobnicate")).toBe(false);
  });







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
