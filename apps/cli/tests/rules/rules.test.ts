import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSystemPrompt } from "../../src/agents/systemPrompt";
import { createRuleInjector, createRulesState, RULE_MARKER_OPEN } from "../../src/rules/match";
import {
  loadRuleRegistry,
  type RuleRegistry,
  renderRulesTier,
  worktreeRelativePath,
} from "../../src/rules/registry";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function makeTree(files: Record<string, string>): { worktree: string; configDir: string } {
  const root = mkdtempSync(join(tmpdir(), "seri-rules-"));
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
  return { worktree, configDir };
}

function load(files: Record<string, string>): {
  rules: RuleRegistry;
  warnings: string[];
  worktree: string;
} {
  const { worktree, configDir } = makeTree(files);
  const warnings: string[] = [];
  const rules = loadRuleRegistry({
    worktree,
    configDir,
    onWarning: (message) => warnings.push(message),
  });
  return { rules, warnings, worktree };
}

const ALWAYS = `---
description: Code-quality rules.
alwaysApply: true
---

Write the minimum code that solves the problem.
`;

const SCOPED = `---
description: TypeScript rules.
globs: "**/*.ts"
alwaysApply: false
---

Make illegal states unrepresentable.
`;

function inject(rules: RuleRegistry, worktree: string) {
  const injector = createRuleInjector({
    rules,
    state: createRulesState(),
    worktree,
    cwd: worktree,
  });
  return injector;
}

describe("loadRuleRegistry", () => {
  test("no rules directory loads nothing and warns about nothing", () => {
    const { rules, warnings } = load({});
    expect(rules.size).toBe(0);
    expect(warnings).toEqual([]);
  });

  test("finds project and global rules, project winning on name", () => {
    const { rules } = load({
      "profile/rules/style.mdc": ALWAYS,
      "project/.seri/rules/style.mdc": ALWAYS.replace(
        "Write the minimum code",
        "The project's own line",
      ),
    });
    expect(rules.size).toBe(1);
    expect(rules.get("style")?.source).toBe("project");
    expect(rules.get("style")?.body).toContain("The project's own line");
  });

  test("a malformed .mdc is skipped with a warning naming the file", () => {
    const { rules, warnings } = load({
      "project/.seri/rules/broken.mdc": "---\nglobs: [unclosed\n---\n\nbody\n",
      "project/.seri/rules/style.mdc": ALWAYS,
    });
    expect([...rules.keys()]).toEqual(["style"]);
    expect(warnings.some((w) => w.includes("broken.mdc") && w.includes("not valid YAML"))).toBe(
      true,
    );
  });

  test("a file with no frontmatter is skipped with a warning naming it", () => {
    const { rules, warnings } = load({ "project/.seri/rules/loose.mdc": "just prose\n" });
    expect(rules.size).toBe(0);
    expect(warnings.some((w) => w.includes("loose.mdc"))).toBe(true);
  });

  // Cursor's fourth type. Loaded, inert, and reported — the author expects it to do something.
  test("a description-only rule loads nothing and says so", () => {
    const { rules, warnings } = load({
      "project/.seri/rules/asked.mdc": "---\ndescription: Only when asked.\n---\n\nbody\n",
    });
    expect(rules.get("asked")?.trigger).toBe("inert");
    expect(warnings.some((w) => w.includes("nothing loads it"))).toBe(true);
    expect(renderRulesTier([...rules.values()])).toBe("");
  });

  // This repo's own code-quality.mdc sets both. alwaysApply wins, and the rule must not then also
  // be injected per touch — the same text would land in the session twice.
  test("alwaysApply wins over globs when a file sets both", () => {
    const { rules, worktree } = load({
      "project/.seri/rules/both.mdc":
        '---\nglobs: "**/*.ts"\nalwaysApply: true\n---\n\nBoth were set.\n',
    });
    expect(rules.get("both")?.trigger).toBe("always");
    expect(rules.get("both")?.globs).toEqual([]);
    expect(renderRulesTier([...rules.values()])).toContain("Both were set.");
    expect(inject(rules, worktree)).toBeUndefined();
  });
});

describe("the context tier", () => {
  test("an alwaysApply rule reaches the assembled prompt, fenced by its filename", () => {
    const { rules } = load({ "project/.seri/rules/style.mdc": ALWAYS });
    const prompt = buildSystemPrompt({
      agentsContent: "PROJECT",
      skills: [],
      rules: [...rules.values()],
    });
    expect(prompt).toContain("# Project rules");
    expect(prompt).toContain("## style");
    expect(prompt).toContain("Write the minimum code that solves the problem.");
  });

  // Negative control for the whole design: a glob-scoped rule must never be in the frozen prompt.
  test("a globs rule is absent from the prompt entirely", () => {
    const { rules } = load({ "project/.seri/rules/ts.mdc": SCOPED });
    const prompt = buildSystemPrompt({
      agentsContent: "PROJECT",
      skills: [],
      rules: [...rules.values()],
    });
    expect(prompt).not.toContain("Make illegal states unrepresentable");
    expect(prompt).not.toContain("# Project rules");
  });

  test("no rules renders byte-identically to before rules existed", () => {
    expect(renderRulesTier([])).toBe("");
    expect(buildSystemPrompt({ agentsContent: "P", skills: [], rules: [] })).toBe(
      buildSystemPrompt({ agentsContent: "P", skills: [] as never, rules: [] }),
    );
  });

  test("AGENTS.md comes before the rules block", () => {
    const { rules } = load({ "project/.seri/rules/style.mdc": ALWAYS });
    const prompt = buildSystemPrompt({
      agentsContent: "PROJECT-CONTRACT",
      skills: [],
      rules: [...rules.values()],
    });
    expect(prompt.indexOf("PROJECT-CONTRACT")).toBeLessThan(prompt.indexOf("# Project rules"));
  });
});

describe("glob matching", () => {
  test("a worktree-relative path is produced with forward slashes on every platform", () => {
    const rel = worktreeRelativePath("/repo", "/repo", join("src", "a.ts"));
    expect(rel).toBe("src/a.ts");
  });

  test("a path outside the worktree never matches", () => {
    expect(worktreeRelativePath("/repo", "/repo", "../elsewhere/a.ts")).toBeUndefined();
  });

  test("a relative path resolves against the session cwd, not the process cwd", () => {
    expect(worktreeRelativePath("/repo", "/repo/sub", "a.ts")).toBe("sub/a.ts");
  });

  // A naive split(",") turns "**/*.{ts,tsx}" into four broken patterns that silently match nothing.
  test("a brace group survives comma splitting, and a comma list does not", () => {
    const { rules } = load({
      "project/.seri/rules/brace.mdc": '---\nglobs: "**/*.{ts,tsx}"\n---\n\nbody\n',
      "project/.seri/rules/list.mdc": "---\nglobs: src/**,docs/x.json\n---\n\nbody\n",
    });
    expect(rules.get("brace")?.globs).toEqual(["**/*.{ts,tsx}"]);
    expect(rules.get("list")?.globs).toEqual(["src/**", "docs/x.json"]);
  });
});

describe("turn injection", () => {
  function run(files: Record<string, string>) {
    const { rules, worktree } = load(files);
    const state = createRulesState();
    const injector = createRuleInjector({ rules, state, worktree, cwd: worktree });
    return { injector, worktree, state };
  }

  test("no glob-scoped rule means no callback at all, so the loop pays nothing", () => {
    const { rules, worktree } = load({ "project/.seri/rules/style.mdc": ALWAYS });
    expect(inject(rules, worktree)).toBeUndefined();
  });

  test("touching a matching file injects the rule, fenced and attributed to the harness", () => {
    const { injector } = run({ "project/.seri/rules/ts.mdc": SCOPED });
    const text = injector?.([{ toolName: "read_file", input: { path: "src/a.ts" } }]);
    expect(text).toContain(RULE_MARKER_OPEN);
    expect(text).toContain('matched="src/a.ts"');
    expect(text).toContain("not from the user");
    expect(text).toContain("## ts");
    expect(text).toContain("Make illegal states unrepresentable.");
  });

  // The plan's own verify line, from the failing side.
  test("touching a non-matching file injects nothing", () => {
    const { injector } = run({ "project/.seri/rules/ts.mdc": SCOPED });
    expect(injector?.([{ toolName: "read_file", input: { path: "README.md" } }])).toBeUndefined();
  });

  test("a rule fires once per session, not on every later touch", () => {
    const { injector } = run({ "project/.seri/rules/ts.mdc": SCOPED });
    expect(injector?.([{ toolName: "write_file", input: { path: "src/a.ts" } }])).toBeDefined();
    expect(injector?.([{ toolName: "write_file", input: { path: "src/b.ts" } }])).toBeUndefined();
  });

  test("two rules matching in one round produce one message carrying both", () => {
    const { injector } = run({
      "project/.seri/rules/ts.mdc": SCOPED,
      "project/.seri/rules/src.mdc": '---\nglobs: "src/**"\n---\n\nSecond rule body.\n',
    });
    const text = injector?.([{ toolName: "read_file", input: { path: "src/a.ts" } }]);
    expect(text?.match(new RegExp(RULE_MARKER_OPEN, "g"))).toHaveLength(1);
    expect(text).toContain("Make illegal states unrepresentable.");
    expect(text).toContain("Second rule body.");
  });

  // edit takes no path, grep/glob take a directory, bash takes free text. Matching any of them
  // would fire a rule on a file the session never actually touched.
  test("only read_file and write_file carry a path the matcher trusts", () => {
    const { injector } = run({ "project/.seri/rules/ts.mdc": SCOPED });
    expect(injector?.([{ toolName: "edit", input: { content: "src/a.ts" } }])).toBeUndefined();
    expect(injector?.([{ toolName: "grep", input: { path: "src/a.ts" } }])).toBeUndefined();
    expect(injector?.([{ toolName: "bash", input: { command: "cat src/a.ts" } }])).toBeUndefined();
  });

  test("a path outside the worktree never fires a project rule", () => {
    const { injector } = run({ "project/.seri/rules/ts.mdc": SCOPED });
    expect(
      injector?.([{ toolName: "read_file", input: { path: "../outside/a.ts" } }]),
    ).toBeUndefined();
  });

  // Windows produces "\" from node:path, and a rule written `src/**` must match the same file on
  // every OS this ships to.
  test("a backslash path matches a forward-slash pattern", () => {
    const { injector } = run({
      "project/.seri/rules/src.mdc": '---\nglobs: "src/**"\n---\n\nSource rule.\n',
    });
    expect(injector?.([{ toolName: "read_file", input: { path: "src\\nested\\a.ts" } }])).toContain(
      "Source rule.",
    );
  });

  test("an empty executed list injects nothing", () => {
    const { injector } = run({ "project/.seri/rules/ts.mdc": SCOPED });
    expect(injector?.([])).toBeUndefined();
  });
});
