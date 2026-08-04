import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

    // spawnSync leaves stdout null when the spawn itself fails, and the child's import throws
    // outright on a fresh clone that has not run postinstall. Surface either as itself rather
    // than as a TypeError or an empty-string mismatch that names neither.
    if (child.status !== 0) throw new Error(`probe child exited ${child.status}: ${child.error ?? child.stderr}`);

    const childRgPath = child.stdout.trim();
    expect(childRgPath).toContain("hesper-rg-");
    expect(existsSync(dirname(childRgPath))).toBe(false);
  }, 30_000);

  test("registers signal cleanup, since 'exit' alone misses Ctrl-C", () => {
    // Importing the module is what wires these up. Weak on its own, but it is the only part of
    // the signal path Windows can observe: process.kill(self, "SIGTERM") there terminates
    // without ever running the handler (measured), so the behavioral check below is POSIX-only.
    expect(process.listenerCount("SIGINT")).toBeGreaterThan(0);
    expect(process.listenerCount("SIGTERM")).toBeGreaterThan(0);
  });

  test.skipIf(process.platform === "win32")("removes the extracted rg when a signal ends the run", async () => {
    // The case the 'exit' listener alone missed: a run aborted part way through, which is what
    // Ctrl-C does. Keeps the child alive with a timer so the signal is what ends it.
    const modulePath = pathToFileURL(join(import.meta.dir, "../../src/tools/runRipgrep.ts")).href;
    const child = spawn(
      process.execPath,
      ["-e", `const m = await import(${JSON.stringify(modulePath)}); console.log(m.rgPath); setInterval(() => {}, 1000);`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const childRgPath = await new Promise<string>((resolve) => {
      child.stdout.setEncoding("utf8");
      child.stdout.once("data", (chunk: string) => resolve(chunk.trim()));
    });
    expect(existsSync(dirname(childRgPath))).toBe(true);

    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));

    expect(existsSync(dirname(childRgPath))).toBe(false);
  }, 30_000);

  test("sweeps rg directories abandoned by earlier runs, but not a live one", () => {
    // Neither the 'exit' listener nor the signal path runs when a process is killed abruptly —
    // on Windows every kill path is TerminateProcess, which runs no user code — so directories
    // accumulate: 236 of them holding 1222 MB on the dev box, 69 from a single day. Not
    // POSIX-guarded, because Windows is where that was measured. Driven through a child because
    // the sweep runs at module scope, which has already happened in this process.
    const abandoned = mkdtempSync(join(tmpdir(), "hesper-rg-"));
    const live = mkdtempSync(join(tmpdir(), `hesper-rg-${process.pid}-`));
    writeFileSync(join(abandoned, "rg"), "not really rg");
    writeFileSync(join(live, "rg"), "not really rg");

    try {
      const modulePath = pathToFileURL(join(import.meta.dir, "../../src/tools/runRipgrep.ts")).href;
      const child = spawnSync(process.execPath, ["-e", `await import(${JSON.stringify(modulePath)});`], {
        encoding: "utf8",
      });
      if (child.status !== 0) throw new Error(`probe child exited ${child.status}: ${child.error ?? child.stderr}`);

      expect(existsSync(abandoned)).toBe(false);
      // The assertion that carries the test: deleting every sibling would satisfy the one above
      // while breaking a concurrent session, whose next grep re-spawns rg from inside its dir.
      expect(existsSync(live)).toBe(true);
    } finally {
      rmSync(abandoned, { recursive: true, force: true });
      rmSync(live, { recursive: true, force: true });
    }
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
