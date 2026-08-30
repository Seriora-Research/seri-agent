import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseHooksFile } from "../../src/hooks/hooksFile";
import { hookMatches } from "../../src/hooks/types";

const DIR = join("project", ".seri", "hooks");
const FILE_PATH = join(DIR, "hooks.yaml");

function load(
  text: string,
  opts: { platform?: NodeJS.Platform; scriptExists?: () => boolean } = {},
) {
  return parseHooksFile({
    text,
    filePath: FILE_PATH,
    dir: DIR,
    source: "project",
    platform: opts.platform ?? "linux",
    scriptExists: opts.scriptExists ?? (() => true),
  });
}

const TWO_EVENT_MANIFEST = `
hooks:
  PreToolUse:
    - script: block-dangerous
      matcher: bash|powershell
    - script: goal-audit
  PostToolUse:
    - script: format-on-edit
      matcher: write_file|edit
      timeout: 10
`;

describe("parseHooksFile", () => {
  test("a valid two-event manifest produces specs in document order", () => {
    const { specs, warnings } = load(TWO_EVENT_MANIFEST);
    expect(warnings).toEqual([]);
    expect(specs.map((s) => `${s.event}:${s.script}`)).toEqual([
      "PreToolUse:block-dangerous",
      "PreToolUse:goal-audit",
      "PostToolUse:format-on-edit",
    ]);
    for (const spec of specs) {
      expect(spec.source).toBe("project");
      expect(spec.filePath).toBe(FILE_PATH);
    }
    expect(specs[1]?.matcher).toBeUndefined();
    expect(specs[2]?.timeoutMs).toBe(10_000);
  });

  test("platform selects the .ps1 half on win32 and the .sh half elsewhere", () => {
    const manifest = `hooks:\n  PreToolUse:\n    - script: block-dangerous\n`;
    const win = load(manifest, { platform: "win32" });
    const linux = load(manifest, { platform: "linux" });
    expect(win.specs[0]?.path).toBe(join(DIR, "block-dangerous.ps1"));
    expect(linux.specs[0]?.path).toBe(join(DIR, "block-dangerous.sh"));
  });

  test("a missing script file warns naming the expected path and the platform, and skips it", () => {
    const manifest = `hooks:\n  PreToolUse:\n    - script: block-dangerous\n`;
    const { specs, warnings } = load(manifest, { platform: "win32", scriptExists: () => false });
    expect(specs).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("block-dangerous.ps1");
    expect(warnings[0]).toContain("win32");
  });

  test("an unknown event key warns and lists the legal event names, and is skipped", () => {
    const { specs, warnings } = load(`hooks:\n  OnStart:\n    - script: foo\n`);
    expect(specs).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"OnStart"');
    expect(warnings[0]).toContain("PreToolUse");
    expect(warnings[0]).toContain("PostToolUse");
  });

  test("a YAML syntax error warns and returns no specs", () => {
    const { specs, warnings } = load("hooks:\n  PreToolUse: [unclosed\n");
    expect(specs).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not valid YAML");
  });

  test("empty text returns no specs and no warnings", () => {
    expect(load("")).toEqual({ specs: [], warnings: [] });
    expect(load("   \n")).toEqual({ specs: [], warnings: [] });
  });

  test("the document not being a mapping warns and returns no specs", () => {
    const { specs, warnings } = load("- just\n- a\n- list\n");
    expect(specs).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  test('a missing "hooks" key warns and returns no specs', () => {
    const { specs, warnings } = load("version: 1\n");
    expect(specs).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"hooks"');
  });

  test('"hooks" not a mapping warns and returns no specs', () => {
    const { specs, warnings } = load("hooks: [a, b]\n");
    expect(specs).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  test("an event whose value is not a sequence warns and is skipped", () => {
    const { specs, warnings } = load(`hooks:\n  PreToolUse: not-a-list\n`);
    expect(specs).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  test("an entry that is not a mapping warns and is skipped, leaving siblings loaded", () => {
    const { specs, warnings } = load(
      `hooks:\n  PreToolUse:\n    - just-a-string\n    - script: goal-audit\n`,
    );
    expect(specs.map((s) => s.script)).toEqual(["goal-audit"]);
    expect(warnings).toHaveLength(1);
  });

  test("script missing, not a string, or empty warns and is skipped, leaving siblings loaded", () => {
    const { specs, warnings } = load(
      `hooks:\n  PreToolUse:\n    - matcher: bash\n    - script: 5\n    - script: ""\n    - script: goal-audit\n`,
    );
    expect(specs.map((s) => s.script)).toEqual(["goal-audit"]);
    expect(warnings).toHaveLength(3);
  });

  test("a script containing a path separator or a dot is rejected, leaving siblings loaded", () => {
    const { specs, warnings } = load(
      `hooks:\n  PreToolUse:\n    - script: sub/script\n    - script: sub\\\\script\n    - script: script.sh\n    - script: goal-audit\n`,
    );
    expect(specs.map((s) => s.script)).toEqual(["goal-audit"]);
    expect(warnings).toHaveLength(3);
    for (const w of warnings) {
      expect(w).toContain("bare file name with no extension and no directory separator");
    }
  });

  test('a script of "../../evil" is rejected', () => {
    const { specs, warnings } = load(`hooks:\n  PreToolUse:\n    - script: ../../evil\n`);
    expect(specs).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("bare file name with no extension and no directory separator");
  });

  test("matcher present but not a string warns and is skipped, leaving siblings loaded", () => {
    const { specs, warnings } = load(
      `hooks:\n  PreToolUse:\n    - script: a\n      matcher: 5\n    - script: goal-audit\n`,
    );
    expect(specs.map((s) => s.script)).toEqual(["goal-audit"]);
    expect(warnings).toHaveLength(1);
  });

  test("matcher present but not a valid regex warns naming the error, leaving siblings loaded", () => {
    const { specs, warnings } = load(
      `hooks:\n  PreToolUse:\n    - script: a\n      matcher: "["\n    - script: goal-audit\n`,
    );
    expect(specs.map((s) => s.script)).toEqual(["goal-audit"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not a valid regular expression");
  });

  test("timeout present but not a positive finite number warns and is skipped, leaving siblings loaded", () => {
    const { specs, warnings } = load(
      `hooks:\n  PreToolUse:\n    - script: a\n      timeout: 0\n    - script: b\n      timeout: -1\n    - script: c\n      timeout: "x"\n    - script: goal-audit\n`,
    );
    expect(specs.map((s) => s.script)).toEqual(["goal-audit"]);
    expect(warnings).toHaveLength(3);
  });

  test("timeout absent falls back to DEFAULT_HOOK_TIMEOUT_MS", () => {
    const { specs } = load(`hooks:\n  PreToolUse:\n    - script: goal-audit\n`);
    expect(specs[0]?.timeoutMs).toBe(30_000);
  });

  test("matcher anchoring: matches the whole tool name, not a substring", () => {
    const { specs } = load(`hooks:\n  PreToolUse:\n    - script: a\n      matcher: edit\n`);
    const spec = specs[0];
    if (spec === undefined) throw new Error("expected a spec");
    expect(hookMatches(spec, "edit")).toBe(true);
    expect(hookMatches(spec, "credit_check")).toBe(false);
  });
});
