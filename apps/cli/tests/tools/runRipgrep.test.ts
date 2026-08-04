import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pkg from "../../package.json";
import { resolveRg, runRipgrep } from "../../src/tools/runRipgrep";

const MODULE = pathToFileURL(join(import.meta.dir, "../../src/tools/runRipgrep.ts")).href;
const ASSET = join(import.meta.dir, "../../src/tools/rg-vendored.bin");
const RESOLVE = [`const m = await import(${JSON.stringify(MODULE)});`, `console.log(m.resolveRg().command);`];

let tmpDir: string;
let cacheRoot: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "seri-runripgrep-test-"));
  cacheRoot = join(tmpDir, "home");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// getConfigDir() reads LOCALAPPDATA on Windows and HOME everywhere else, and it checks the
// environment before falling back to homedir(), so setting one variable redirects the whole cache.
// It has to be set at spawn time on a child rather than mutated in process: resolveRg() memoizes,
// so any one process can only ever observe a single cache.
function cacheEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = process.platform === "win32" ? { LOCALAPPDATA: root } : { HOME: root };
  return { ...process.env, ...home, ...extra };
}

function configDirIn(root: string): string {
  return join(root, process.platform === "win32" ? "seri" : ".seri");
}

// An rg stand-in that answers --version and nothing else, for the two rejections in the gate test.
// A .cmd is what Windows can execute without a shell — measured: bun's spawnSync runs one directly
// — and a shebang script does the same job everywhere else.
function versionStub(line: string): string {
  if (process.platform === "win32") {
    const path = join(tmpDir, "rgstub.cmd");
    writeFileSync(path, `@echo off\r\necho ${line}\r\n`);
    return path;
  }
  const path = join(tmpDir, "rgstub.sh");
  writeFileSync(path, `#!/bin/sh\necho '${line}'\n`);
  chmodSync(path, 0o755);
  return path;
}

function runChild(script: string[], env: NodeJS.ProcessEnv): string[] {
  const child = spawnSync(process.execPath, ["-e", script.join("\n")], { encoding: "utf8", env });
  // spawnSync leaves stdout null when the spawn itself fails, and the child's import throws
  // outright on a fresh clone that has not run postinstall. Surface either as itself rather
  // than as a TypeError or an empty-string mismatch that names neither.
  if (child.status !== 0) throw new Error(`probe child exited ${child.status}: ${child.error ?? child.stderr}`);
  return child.stdout.trim().split(/\r?\n/);
}

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

  test("writes nothing until something actually searches", () => {
    // The whole point of the change: --version, login, logout and config never search, and used
    // to pay 5 429 760 bytes of extraction anyway. Only a child can show it, because this process
    // has already resolved rg.
    const [before, command] = runChild(
      [
        `const { existsSync } = await import("node:fs");`,
        `const m = await import(${JSON.stringify(MODULE)});`,
        `console.log(existsSync(${JSON.stringify(configDirIn(cacheRoot))}));`,
        `console.log(m.resolveRg().command);`,
      ],
      cacheEnv(cacheRoot),
    );

    expect(before).toBe("false");
    expect(existsSync(String(command))).toBe(true);
  }, 30_000);

  test("serves later runs from the cache instead of writing it again", () => {
    // The cache-hit contract, and the assertion that fails the moment resolution stops being
    // memoized or starts re-populating: a second process must reuse the very same file,
    // untouched. Two stats cost 0.033 ms where a rewrite costs 2.80 ms and 5.4 MB.
    const script = [
      `const { statSync } = await import("node:fs");`,
      `const m = await import(${JSON.stringify(MODULE)});`,
      `console.log(m.resolveRg().command);`,
      `console.log(m.resolveRg().command);`,
      `console.log(statSync(m.resolveRg().command).mtimeMs);`,
    ];
    const [firstCommand, secondCommand, firstMtime] = runChild(script, cacheEnv(cacheRoot));
    const [thirdCommand, , secondMtime] = runChild(script, cacheEnv(cacheRoot));

    expect(secondCommand).toBe(String(firstCommand));
    expect(thirdCommand).toBe(String(firstCommand));
    expect(secondMtime).toBe(String(firstMtime));
  }, 30_000);

  test("survives four processes populating one empty cache at once", () => {
    // No lockfile, by design: every racer writes byte-identical bytes to its own pid-suffixed
    // temp name and renames, so last-writer-wins is indistinguishable from first. What this
    // checks is that nobody ever sees a half-written binary and nobody leaves a .tmp behind.
    const script = [`const m = await import(${JSON.stringify(MODULE)});`, `m.resolveRg();`].join("\n");
    const exits = Promise.all(
      [0, 1, 2, 3].map(
        () =>
          new Promise<number | null>((resolve) => {
            const child = spawn(process.execPath, ["-e", script], { env: cacheEnv(cacheRoot), stdio: "ignore" });
            child.once("exit", resolve);
          }),
      ),
    );

    return exits.then((codes) => {
      expect(codes).toEqual([0, 0, 0, 0]);

      const cacheDir = join(configDirIn(cacheRoot), "rg");
      const keyDir = join(cacheDir, String(readdirSync(cacheDir)[0]));
      expect(readdirSync(keyDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);

      const rg = join(keyDir, process.platform === "win32" ? "rg.exe" : "rg");
      expect(statSync(rg).size).toBe(statSync(ASSET).size);
      expect(spawnSync(rg, ["--version"], { encoding: "utf8" }).stdout).toContain("ripgrep");
    });
  }, 30_000);

  test("replaces a cached binary that is the wrong size instead of running it", () => {
    // A truncated rg is worse than an absent one: it either fails unreadably or, worse, half
    // works. The atomic rename makes that impossible from an interrupted populate, so this forces
    // the case a full disk or a bad restore would produce and checks the size guard catches it.
    const [command] = runChild(RESOLVE, cacheEnv(cacheRoot));
    writeFileSync(String(command), "not really rg");

    const [again] = runChild(RESOLVE, cacheEnv(cacheRoot));

    expect(again).toBe(String(command));
    expect(statSync(String(again)).size).toBe(statSync(ASSET).size);
  }, 30_000);

  test("keys the cache so a different seri or a different rg cannot reuse it", () => {
    // Every release ships exactly one vendored rg, so the version bump alone would do — the asset
    // size is there for the developer who re-vendors a different rg without bumping. An entry
    // under another key is left strictly alone: nothing here sweeps, by design.
    const [command] = runChild(RESOLVE, cacheEnv(cacheRoot));
    const cacheDir = join(configDirIn(cacheRoot), "rg");
    expect(readdirSync(cacheDir)).toEqual([`${pkg.version}-${process.platform}-${process.arch}-${statSync(ASSET).size}`]);

    const foreign = join(cacheDir, "0.0.0-otherplatform-otherarch-1");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "rg"), "another seri's rg");

    const [again] = runChild(RESOLVE, cacheEnv(cacheRoot));

    expect(again).toBe(String(command));
    expect(statSync(join(foreign, "rg")).size).toBe("another seri's rg".length);
  }, 30_000);

  test("only trusts an rg it did not vendor once that rg has proved itself", () => {
    // SERI_RIPGREP and SERI_USE_BUILTIN_RIPGREP hand seri a binary its own suite has never run.
    // The gate is a version floor plus a real --json round trip, because the risk is not a parse
    // error — three rg builds, including a third-party fork, emitted byte-identical --json — it is
    // a build old or odd enough that nobody has checked. The vendored copy stands in for "a system
    // rg" because there is no rg on PATH on this box at all, which would make a PATH test a coin
    // flip.
    writeFileSync(join(tmpDir, "a.txt"), "needle\n");
    const script = [
      `const m = await import(${JSON.stringify(MODULE)});`,
      `try {`,
      `  const found = m.runRipgrep(["--json", "needle", ${JSON.stringify(tmpDir)}]).stdout.includes("needle");`,
      `  console.log(m.resolveRg().mode + " " + found);`,
      `} catch (error) { console.log("rejected: " + error.message); }`,
    ];

    const [tooOld] = runChild(script, cacheEnv(cacheRoot, { SERI_RIPGREP: versionStub("ripgrep 9.9.9") }));
    expect(tooOld).toContain("rejected:");
    expect(tooOld).toContain("9.9.9");

    const [notRg] = runChild(script, cacheEnv(cacheRoot, { SERI_RIPGREP: versionStub("not-ripgrep 15.0.0") }));
    expect(notRg).toContain("rejected:");

    const [vendored] = runChild(script, cacheEnv(cacheRoot, { SERI_RIPGREP: resolveRg().command }));
    expect(vendored).toBe("system true");
  }, 30_000);

  test("still throws when rg genuinely fails", () => {
    expect(() => runRipgrep(["--definitely-not-a-real-flag", tmpDir])).toThrow(/rg exited with code/);
  });

  test("names the cause when rg cannot be run at all", () => {
    // The cached rg can vanish mid-session — an installer, a disk cleaner, an AV quarantine.
    // spawnSync then reports no status and no stderr, which the exit-code path rendered as
    // "rg exited with code undefined: null". Resolution is memoized and never re-runs, so parking
    // the binary really does break rg rather than being silently healed.
    const rgPath = resolveRg().command;
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
    // developer's ~/.ripgreprc silently changes what seri finds on their machine and
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
