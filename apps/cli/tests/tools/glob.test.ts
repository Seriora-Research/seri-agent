import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { glob } from "../../src/tools/glob";
import { MAX_FILE_RESULTS } from "../../src/tools/runRipgrep";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "seri-glob-test-"));
  writeFileSync(join(tmpDir, "a.txt"), "a");
  writeFileSync(join(tmpDir, "b.txt"), "b");
  writeFileSync(join(tmpDir, "c.js"), "c");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("glob", () => {
  test("matches a known fixture set by extension pattern", async () => {
    const { files, truncated } = await glob("*.txt", { path: tmpDir });
    expect(files).toHaveLength(2);
    expect(files.every((file) => file.endsWith(".txt"))).toBe(true);
    expect(truncated).toBe(false);
  });

  test("resolves a path that rg would otherwise read as a flag", async () => {
    // Two dashes, not one: rg happily treats `-weird` as a path, but reads `--weird` as a long
    // flag and exits 2 with "unrecognized flag", which runRipgrep turns into a thrown error.
    // The dashes have to lead the argument, so the path must be relative — hence the chdir.
    mkdirSync(join(tmpDir, "--weird"));
    writeFileSync(join(tmpDir, "--weird", "d.js"), "d");

    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const { files } = await glob("*.js", { path: "--weird" });

      expect(files).toHaveLength(1);
      expect(files[0].endsWith("d.js")).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  // The model called glob against a directory that did not exist and got rg's exit code and its
  // localized OS strerror back, through the loop, as `Tool "glob" threw during execution: Error:
  // rg exited with code 2: rg: <path>: IO error for operation on <path>: …`. Asserted on our own
  // message and on the ABSENCE of rg's, never on rg's wording — that tail differs between Windows
  // and Linux and is localized on both.
  test("a missing path is reported as a missing path, not as a ripgrep exit code", async () => {
    const missing = join(tmpDir, "does-not-exist");

    const error = (await glob("*.txt", { path: missing }).catch((e: Error) => e)) as Error;

    expect(error.message).toBe(`Path not found: ${missing}`);
    expect(error.message).not.toContain("rg exited with code");
    expect(error.message).not.toContain("IO error for operation");
  });

  // The path exists; only the traversal through its parent is denied — which existsSync could not
  // tell apart from the case above, so both arrived as "Path not found" and sent the model looking
  // somewhere else instead of at the permissions. Guarded like config/commands.test.ts's 0600 case:
  // chmod does not deny access this way on Windows, and root ignores the mode bits outright.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "an unreadable path is reported as a permission problem, not as a missing path",
    async () => {
      const parent = join(tmpDir, "locked");
      const target = join(parent, "inner");
      mkdirSync(target, { recursive: true });
      chmodSync(parent, 0o000);

      try {
        const error = (await glob("*.txt", { path: target }).catch((e: Error) => e)) as Error;

        expect(error.message).toBe(`Permission denied: ${target}`);
      } finally {
        // Restored before afterEach, which cannot remove a directory it cannot enter.
        chmodSync(parent, 0o755);
      }
    },
  );

  test("caps the results and flags truncation when more files match than the cap", async () => {
    for (let i = 0; i < MAX_FILE_RESULTS + 50; i++) writeFileSync(join(tmpDir, `f${i}.md`), "x");

    const { files, truncated } = await glob("*.md", { path: tmpDir });

    expect(files).toHaveLength(MAX_FILE_RESULTS);
    expect(truncated).toBe(true);
  });
});
