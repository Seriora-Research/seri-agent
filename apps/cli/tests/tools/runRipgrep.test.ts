import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRipgrep } from "../../src/tools/runRipgrep";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "hesper-runripgrep-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("runRipgrep", () => {
  test("returns stdout and reports no truncation for an ordinary search", () => {
    writeFileSync(join(tmpDir, "a.txt"), "needle\n");

    const { stdout, truncated } = runRipgrep(["--json", "needle", tmpDir]);

    expect(truncated).toBe(false);
    expect(stdout).toContain("needle");
  });

  test("reports truncation instead of throwing when rg outruns the stdout buffer", () => {
    // --json emits one event per match at a few hundred bytes each, so this overshoots the
    // buffer several times over rather than sitting on the limit. Before the fix spawnSync
    // killed rg here and the caller saw `rg exited with code null:` with an empty stderr —
    // an rg crash that never happened, and every match found so far thrown away.
    writeFileSync(join(tmpDir, "big.txt"), "needle here on this line\n".repeat(60_000));

    const { stdout, truncated } = runRipgrep(["--json", "needle", tmpDir]);

    expect(truncated).toBe(true);
    expect(stdout.length).toBeGreaterThan(0);
  });

  test("still throws when rg genuinely fails", () => {
    expect(() => runRipgrep(["--definitely-not-a-real-flag", tmpDir])).toThrow(/rg exited with code/);
  });

  test("ignores the user's own ripgrep config", () => {
    // rg picks up RIPGREP_CONFIG_PATH from the environment, so without --no-config a
    // developer's ~/.ripgreprc silently changes what hesper finds on their machine and
    // nowhere else. This config would hide the only matching file.
    writeFileSync(join(tmpDir, "a.txt"), "needle\n");
    const configPath = join(tmpDir, "ripgreprc");
    writeFileSync(configPath, "--glob=!*.txt\n");

    const original = process.env.RIPGREP_CONFIG_PATH;
    process.env.RIPGREP_CONFIG_PATH = configPath;
    try {
      const { stdout } = runRipgrep(["--json", "needle", tmpDir]);
      expect(stdout).toContain("needle");
    } finally {
      // Assigning a captured `undefined` back would set the literal string "undefined".
      if (original === undefined) delete process.env.RIPGREP_CONFIG_PATH;
      else process.env.RIPGREP_CONFIG_PATH = original;
    }
  });
});
