import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkTrust,
  digestHooksDir,
  hooksTrustPath,
  trustHooksDir,
  untrustHooksDir,
} from "../../src/hooks/trust";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function makeTree(files: Record<string, string>): { root: string; configDir: string } {
  const root = mkdtempSync(join(tmpdir(), "seri-hooks-"));
  roots.push(root);
  const configDir = join(root, "profile");
  mkdirSync(join(root, "project"), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  for (const [relative, text] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return { root, configDir };
}

const MANIFEST = `hooks:\n  PreToolUse:\n    - script: block-dangerous\n`;
const SH = "#!/bin/sh\nexit 0\n";
const PS1 = "exit 0\n";

function makeHooks(extra: Record<string, string> = {}): {
  configDir: string;
  hooksDir: string;
  root: string;
} {
  const { root, configDir } = makeTree({
    "project/.seri/hooks/hooks.yaml": MANIFEST,
    "project/.seri/hooks/block-dangerous.sh": SH,
    "project/.seri/hooks/block-dangerous.ps1": PS1,
    ...extra,
  });
  return { root, configDir, hooksDir: join(root, "project", ".seri", "hooks") };
}

describe("digestHooksDir", () => {
  test("the same directory digests identically twice, to full-length sha256 hex", () => {
    const { hooksDir } = makeHooks();
    const first = digestHooksDir(hooksDir);
    expect(first).toEqual(digestHooksDir(hooksDir));
    expect([...first.keys()]).toEqual(["block-dangerous.ps1", "block-dangerous.sh", "hooks.yaml"]);
    for (const digest of first.values()) expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a directory that does not exist digests to nothing instead of throwing", () => {
    const { root } = makeHooks();
    expect(digestHooksDir(join(root, "nope")).size).toBe(0);
  });

  // The whole claim the grant makes is that the bytes reviewed are the bytes that run, and a
  // trusted script can `source ./lib/common.sh`. A shallow walk would leave that helper editable
  // with the digest never moving.
  test("a helper in a subdirectory is inside the digest, keyed by its relative path", () => {
    const { hooksDir } = makeHooks({ "project/.seri/hooks/lib/common.sh": SH });
    expect([...digestHooksDir(hooksDir).keys()]).toEqual([
      "block-dangerous.ps1",
      "block-dangerous.sh",
      "hooks.yaml",
      "lib/common.sh",
    ]);
  });

  test("editing a helper one level down is a change, not a silent pass", () => {
    const { root, hooksDir } = makeHooks({ "project/.seri/hooks/lib/common.sh": SH });
    const configDir = join(root, "profile");
    trustHooksDir(configDir, hooksDir);
    expect(checkTrust({ configDir, dir: hooksDir }).kind).toBe("trusted");

    writeFileSync(
      join(hooksDir, "lib", "common.sh"),
      `${SH}
# and now something else
`,
    );
    const after = checkTrust({ configDir, dir: hooksDir });
    expect(after.kind).toBe("changed");
    expect(after.kind === "changed" && after.files).toEqual(["lib/common.sh"]);
  });
});

describe("checkTrust", () => {
  test("a directory with no grant is untrusted", () => {
    const { configDir, hooksDir } = makeHooks();
    expect(checkTrust({ configDir, dir: hooksDir })).toEqual({ kind: "untrusted" });
  });

  test("a directory reads back trusted after trustHooksDir, from a fresh read of the file", () => {
    const { configDir, hooksDir } = makeHooks();
    trustHooksDir(configDir, hooksDir);
    expect(checkTrust({ configDir, dir: hooksDir })).toEqual({ kind: "trusted" });
  });

  // Emptying a reviewed directory drops it back to untrusted rather than reporting every file as
  // changed: with nothing left there is no longer anything for the grant to have been about, and
  // "re-review these three files" would name files that no longer exist.
  test("a trusted directory emptied of every file is untrusted, not changed", () => {
    const { configDir, hooksDir } = makeHooks();
    trustHooksDir(configDir, hooksDir);
    for (const name of ["hooks.yaml", "block-dangerous.sh", "block-dangerous.ps1"]) {
      rmSync(join(hooksDir, name));
    }
    expect(checkTrust({ configDir, dir: hooksDir })).toEqual({ kind: "untrusted" });
  });

  test("editing a script names that script as changed", () => {
    const { configDir, hooksDir } = makeHooks();
    trustHooksDir(configDir, hooksDir);
    writeFileSync(join(hooksDir, "block-dangerous.sh"), `${SH}rm -rf /\n`);
    expect(checkTrust({ configDir, dir: hooksDir })).toEqual({
      kind: "changed",
      files: ["block-dangerous.sh"],
    });
  });

  // The attack the manifest is in the digest for: every script byte is untouched, and rewiring a
  // lenient PostToolUse script onto PreToolUse with a catch-all matcher changes what runs.
  test("editing hooks.yaml alone is changed, with no script edited", () => {
    const { configDir, hooksDir } = makeHooks();
    trustHooksDir(configDir, hooksDir);
    writeFileSync(
      join(hooksDir, "hooks.yaml"),
      `hooks:\n  PreToolUse:\n    - script: block-dangerous\n      matcher: ".*"\n`,
    );
    expect(checkTrust({ configDir, dir: hooksDir })).toEqual({
      kind: "changed",
      files: ["hooks.yaml"],
    });
  });

  test("adding a file is changed", () => {
    const { configDir, hooksDir } = makeHooks();
    trustHooksDir(configDir, hooksDir);
    writeFileSync(join(hooksDir, "common.sh"), SH);
    expect(checkTrust({ configDir, dir: hooksDir })).toEqual({
      kind: "changed",
      files: ["common.sh"],
    });
  });

  test("removing a file is changed", () => {
    const { configDir, hooksDir } = makeHooks();
    trustHooksDir(configDir, hooksDir);
    rmSync(join(hooksDir, "block-dangerous.ps1"));
    expect(checkTrust({ configDir, dir: hooksDir })).toEqual({
      kind: "changed",
      files: ["block-dangerous.ps1"],
    });
  });

  test("two hooks directories are independent entries, and editing one leaves the other trusted", () => {
    const { root, configDir, hooksDir } = makeHooks({
      "project-b/.seri/hooks/hooks.yaml": MANIFEST,
      "project-b/.seri/hooks/block-dangerous.sh": SH,
    });
    const otherDir = join(root, "project-b", ".seri", "hooks");
    trustHooksDir(configDir, hooksDir);
    trustHooksDir(configDir, otherDir);

    writeFileSync(join(otherDir, "block-dangerous.sh"), `${SH}echo hi\n`);

    expect(checkTrust({ configDir, dir: hooksDir })).toEqual({ kind: "trusted" });
    expect(checkTrust({ configDir, dir: otherDir }).kind).toBe("changed");
  });
});

describe("untrustHooksDir", () => {
  test("revoking a grant returns true and the directory reads untrusted again", () => {
    const { configDir, hooksDir } = makeHooks();
    trustHooksDir(configDir, hooksDir);
    expect(untrustHooksDir(configDir, hooksDir)).toBe(true);
    expect(checkTrust({ configDir, dir: hooksDir })).toEqual({ kind: "untrusted" });
  });

  test("a directory that was never trusted returns false", () => {
    const { configDir, hooksDir } = makeHooks();
    expect(untrustHooksDir(configDir, hooksDir)).toBe(false);
    trustHooksDir(configDir, hooksDir);
    expect(untrustHooksDir(configDir, join(hooksDir, "..", "elsewhere"))).toBe(false);
  });
});

describe("the store file", () => {
  test("a malformed store warns, reads untrusted, and is not clobbered by a grant", () => {
    const { configDir, hooksDir } = makeHooks();
    const path = hooksTrustPath(configDir);
    writeFileSync(path, ":::not yaml:::");
    const before = readFileSync(path, "utf8");

    const warnings: string[] = [];
    expect(checkTrust({ configDir, dir: hooksDir, onWarning: (m) => warnings.push(m) })).toEqual({
      kind: "untrusted",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(path);

    trustHooksDir(configDir, hooksDir, (m) => warnings.push(m));
    expect(readFileSync(path, "utf8")).toBe(before);
    // Refused, and said so: a caller that printed "trusted" over a write that never landed would
    // leave the user believing a grant exists.
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain(path);
    expect(checkTrust({ configDir, dir: hooksDir })).toEqual({ kind: "untrusted" });
  });

  test("hand-written comments and other entries survive a grant", () => {
    const { configDir, hooksDir } = makeHooks();
    const path = hooksTrustPath(configDir);
    writeFileSync(
      path,
      `# reviewed these on purpose\nhooks:\n  "/other/repo/.seri/hooks":\n    hooks.yaml: ${"a".repeat(64)}\n`,
    );

    trustHooksDir(configDir, hooksDir);

    const after = readFileSync(path, "utf8");
    expect(after).toContain("# reviewed these on purpose");
    expect(after).toContain("/other/repo/.seri/hooks");
    expect(checkTrust({ configDir, dir: hooksDir })).toEqual({ kind: "trusted" });
  });
});
