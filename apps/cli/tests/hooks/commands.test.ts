import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decideHooksCommand, hooksCommandAccepts } from "../../src/hooks/commands";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function makeTree(files: Record<string, string>): { worktree: string; configDir: string } {
  const root = mkdtempSync(join(tmpdir(), "seri-hooks-cmd-"));
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

// Written for both platforms in every fixture, so the registry resolves the same hook on
// Linux, macOS and Windows CI runners without a per-OS branch in the test itself.
function scriptPair(name: string, label: string): Record<string, string> {
  return {
    [`${name}.sh`]: `#!/bin/sh\necho "${label}"\n`,
    [`${name}.ps1`]: `Write-Output "${label}"\n`,
  };
}

const MANIFEST = `hooks:
  PreToolUse:
    - script: block-dangerous
      matcher: edit
  PostToolUse:
    - script: format
`;

function projectHooksTree(extra: Record<string, string> = {}) {
  const pair = scriptPair("block-dangerous", "block-dangerous");
  const formatPair = scriptPair("format", "format");
  return {
    "project/.seri/hooks/hooks.yaml": MANIFEST,
    "project/.seri/hooks/block-dangerous.sh": pair["block-dangerous.sh"] as string,
    "project/.seri/hooks/block-dangerous.ps1": pair["block-dangerous.ps1"] as string,
    "project/.seri/hooks/format.sh": formatPair["format.sh"] as string,
    "project/.seri/hooks/format.ps1": formatPair["format.ps1"] as string,
    ...extra,
  };
}

describe("hooksCommandAccepts", () => {
  test("accepts the bare, list, show, trust and untrust forms", () => {
    expect(hooksCommandAccepts([])).toBe(true);
    expect(hooksCommandAccepts(["list"])).toBe(true);
    expect(hooksCommandAccepts(["show"])).toBe(true);
    expect(hooksCommandAccepts(["trust"])).toBe(true);
    expect(hooksCommandAccepts(["untrust"])).toBe(true);
  });

  test("rejects extra arguments on every form", () => {
    expect(hooksCommandAccepts(["list", "x"])).toBe(false);
    expect(hooksCommandAccepts(["show", "x"])).toBe(false);
    expect(hooksCommandAccepts(["trust", "x"])).toBe(false);
    expect(hooksCommandAccepts(["untrust", "x"])).toBe(false);
  });

  test("rejects an unknown subcommand", () => {
    expect(hooksCommandAccepts(["wat"])).toBe(false);
  });
});

describe("list", () => {
  test("an untrusted project directory says nothing runs, with no wiring table", () => {
    const { worktree, configDir } = makeTree(projectHooksTree());
    const { lines } = decideHooksCommand([], { worktree, configDir });
    const text = lines.join("\n");
    expect(text).toContain("Not reviewed. Nothing in it runs.");
    expect(text).not.toContain("block-dangerous");
    expect(text).not.toContain("PreToolUse");
  });

  test("after trust, wiring rows show the matcher, and (every tool) for a hook with none", () => {
    const { worktree, configDir } = makeTree(projectHooksTree());
    decideHooksCommand(["trust"], { worktree, configDir });
    const { lines } = decideHooksCommand([], { worktree, configDir });
    const text = lines.join("\n");
    expect(text).toContain("Trusted. Hooks below are live.");
    expect(
      lines.some(
        (l) => l.includes("PreToolUse") && l.includes("edit") && l.includes("block-dangerous"),
      ),
    ).toBe(true);
    expect(
      lines.some(
        (l) => l.includes("PostToolUse") && l.includes("(every tool)") && l.includes("format"),
      ),
    ).toBe(true);
  });

  test("the profile scope shows its hooks with no grant involved at all", () => {
    const pair = scriptPair("audit", "audit");
    const { worktree, configDir } = makeTree({
      "profile/hooks/hooks.yaml": "hooks:\n  PreToolUse:\n    - script: audit\n",
      "profile/hooks/audit.sh": pair["audit.sh"] as string,
      "profile/hooks/audit.ps1": pair["audit.ps1"] as string,
    });
    const { lines } = decideHooksCommand([], { worktree, configDir });
    expect(lines.some((l) => l.includes("PreToolUse") && l.includes("audit"))).toBe(true);
  });
});

describe("show", () => {
  test("prints the full body of every file, including one in lib/, without truncation", () => {
    const longLine = "x".repeat(500);
    const { worktree, configDir } = makeTree(
      projectHooksTree({ "project/.seri/hooks/lib/common.sh": `#!/bin/sh\n${longLine}\n` }),
    );
    const { lines } = decideHooksCommand(["show"], { worktree, configDir });
    const text = lines.join("\n");
    expect(text).toContain("── lib/common.sh ──");
    expect(text).toContain(longLine);
    expect(text).toContain("── block-dangerous.sh ──");
    expect(text).toContain('echo "block-dangerous"');
    expect(lines.some((l) => l.includes("/hooks trust turns them on"))).toBe(true);
  });
});

describe("trust and untrust", () => {
  test("trust then list reports trusted; untrust then list reports not reviewed", () => {
    const { worktree, configDir } = makeTree(projectHooksTree());
    const trustLines = decideHooksCommand(["trust"], { worktree, configDir }).lines;
    expect(
      trustLines.some((l) => l.includes("It loads in the next session, or after /clear.")),
    ).toBe(true);
    expect(decideHooksCommand([], { worktree, configDir }).lines.join("\n")).toContain(
      "Trusted. Hooks below are live.",
    );

    const untrustLines = decideHooksCommand(["untrust"], { worktree, configDir }).lines;
    expect(untrustLines.some((l) => l.includes("Untrusted"))).toBe(true);
    expect(decideHooksCommand([], { worktree, configDir }).lines.join("\n")).toContain(
      "Not reviewed. Nothing in it runs.",
    );
  });

  test("trust with no project hooks directory refuses without throwing", () => {
    const { worktree, configDir } = makeTree({});
    const { lines } = decideHooksCommand(["trust"], { worktree, configDir });
    expect(lines.some((l) => l.includes("No project hooks directory"))).toBe(true);
  });

  test("editing a script after trust makes list report the change and name the file", () => {
    const { worktree, configDir } = makeTree(projectHooksTree());
    decideHooksCommand(["trust"], { worktree, configDir });
    writeFileSync(
      join(worktree, ".seri", "hooks", "block-dangerous.sh"),
      '#!/bin/sh\necho "edited"\n',
    );
    const { lines } = decideHooksCommand([], { worktree, configDir });
    const text = lines.join("\n");
    expect(text).toContain("Changed:");
    expect(text).toContain("block-dangerous.sh");
    expect(text).toContain("Nothing runs until it is reviewed again.");
  });
});
