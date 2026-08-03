import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { rgPath, runRipgrep } from "../../src/tools/runRipgrep";

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

  test("removes the extracted rg when the process exits", () => {
    // The binary is written to a fresh temp dir at startup and has to stay executable for the
    // whole process lifetime, so this can only be checked from outside: run a real child, ask
    // it where it put rg, then look after it is gone. Every run used to leave 5 MB behind.
    const modulePath = pathToFileURL(join(import.meta.dir, "../../src/tools/runRipgrep.ts")).href;
    const child = spawnSync(process.execPath, ["-e", `const m = await import(${JSON.stringify(modulePath)}); console.log(m.rgPath);`], {
      encoding: "utf8",
    });

    const childRgPath = child.stdout.trim();
    expect(childRgPath).toContain("hesper-rg-");
    expect(existsSync(dirname(childRgPath))).toBe(false);
  }, 30_000);

  test("still throws when rg genuinely fails", () => {
    expect(() => runRipgrep(["--definitely-not-a-real-flag", tmpDir])).toThrow(/rg exited with code/);
  });

  test("names the cause when rg cannot be run at all", () => {
    // The embedded rg is extracted to a temp file at startup, so it can vanish mid-session —
    // reaped by a tmp cleaner, or quarantined by antivirus. spawnSync then reports no status
    // and no stderr, which the exit-code path rendered as "rg exited with code undefined: null".
    const parked = `${rgPath}.parked`;
    renameSync(rgPath, parked);
    try {
      expect(() => runRipgrep(["--json", "needle", tmpDir])).toThrow(/failed to run rg/);
    } finally {
      renameSync(parked, rgPath);
    }
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
