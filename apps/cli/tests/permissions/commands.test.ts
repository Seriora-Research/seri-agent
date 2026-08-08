import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { permissionsCommand } from "../../src/permissions/commands";
import { loadGrants, permissionsPath, projectKey, rememberGrant } from "../../src/permissions/store";

describe("permissionsCommand", () => {
  let configDir: string;
  const worktree = "/w";
  let logs: string[];
  let errors: string[];
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "seri-permissions-cmd-test-"));
    logs = [];
    errors = [];
    console.log = (msg: string) => logs.push(String(msg));
    console.error = (msg: string) => errors.push(String(msg));
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    rmSync(configDir, { recursive: true, force: true });
  });

  // 13. list on an empty store.
  test("list on an empty store names the path and says nothing is approved", () => {
    const code = permissionsCommand(["list"], configDir, worktree);

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("No tools are permanently approved");
    expect(logs.join("\n")).toContain(configDir);
  });

  // A malformed/unreadable store must not read as "nothing is stored" — HIGH-1's degrade path
  // makes loadGrants return the same empty shape for "absent" and for "present but unreadable",
  // and `list` is the one place a user checks that distinction to decide whether to go fix the
  // file. The directory-collision trick reproduces EISDIR on every platform, including Windows.
  test("list on an unreadable store warns and does not claim nothing is stored", () => {
    mkdirSync(permissionsPath(configDir));

    const code = permissionsCommand(["list"], configDir, worktree);

    expect(code).toBe(0);
    expect(logs.join("\n")).not.toContain("No tools are permanently approved");
    expect(logs.join("\n")).not.toContain("nothing is stored");
    expect(logs.join("\n")).toContain("could not be read");
    expect(errors.some((line) => line.includes("⚠"))).toBe(true);
  });

  // 14. list with a global entry, a project entry and one other project.
  test("list shows both sections, both tool names, the worktree, and the other-project count", () => {
    rememberGrant(configDir, "/other", "edit");
    rememberGrant(configDir, worktree, "write_file");
    // Hand-add a global grant: rememberGrant never writes to global (DECISION 1).
    const raw = readFileSync(permissionsPath(configDir), "utf8");
    writeFileSync(permissionsPath(configDir), raw.replace("global: []", "global: [edit]"));

    const code = permissionsCommand(["list"], configDir, worktree);

    expect(code).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("every project:");
    expect(output).toContain("this project");
    expect(output).toContain("edit");
    expect(output).toContain("write_file");
    expect(output).toContain(worktree);
    expect(output).toContain("1 other project");
  });

  // 15. remove <tool> when it is in both sections — the point of the command.
  test("remove clears a tool from both the global and project sections", () => {
    const raw = `global: [write_file]\nprojects:\n  '${projectKey(worktree)}':\n    - write_file\n`;
    writeFileSync(permissionsPath(configDir), raw);

    const code = permissionsCommand(["remove", "write_file"], configDir, worktree);

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("global list and from this project");
    expect(loadGrants(configDir, worktree)).toEqual({ global: [], project: [], otherProjects: 0 });
  });

  // 16. remove <tool> when nothing was granted.
  test("remove reports when the tool was never approved", () => {
    const code = permissionsCommand(["remove", "write_file"], configDir, worktree);

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("write_file was not permanently approved.");
  });

  // 17. remove bash.
  test("remove bash says it can never be permanently approved", () => {
    const code = permissionsCommand(["remove", "bash"], configDir, worktree);

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("bash was not permanently approved — bash and powershell never can be.");
  });

  // 18. No subcommand / bogus / remove with no tool.
  test("no subcommand prints usage on stderr and exits 2", () => {
    const code = permissionsCommand([], configDir, worktree);

    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("Usage:");
  });

  test("an unknown subcommand prints usage on stderr and exits 2", () => {
    const code = permissionsCommand(["bogus"], configDir, worktree);

    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("Usage:");
  });

  test("remove with no tool prints usage on stderr and exits 2", () => {
    const code = permissionsCommand(["remove"], configDir, worktree);

    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("Usage:");
  });
});
