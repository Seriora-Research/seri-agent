import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pkg from "../../package.json";
import { runRipgrep } from "../../src/tools/runRipgrep";

const MODULE = pathToFileURL(join(import.meta.dir, "../../src/tools/runRipgrep.ts")).href;
const ASSET = join(import.meta.dir, "../../src/tools/rg-vendored.bin");
const IMPORT = `const m = await import(${JSON.stringify(MODULE)});`;
const RESOLVE = [IMPORT, `console.log(m.resolveRg());`];

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
function cacheEnv(root: string): NodeJS.ProcessEnv {
  const home = process.platform === "win32" ? { LOCALAPPDATA: root } : { HOME: root };
  return { ...process.env, ...home };
}

function configDirIn(root: string): string {
  return join(root, process.platform === "win32" ? "seri" : ".seri");
}

function runChild(script: string[], env: NodeJS.ProcessEnv): string[] {
  const child = spawnSync(process.execPath, ["-e", script.join("\n")], { encoding: "utf8", env });
  // spawnSync leaves stdout null when the spawn itself fails, and the child's import throws
  // outright on a fresh clone that has not run postinstall. Surface either as itself rather
  // than as a TypeError or an empty-string mismatch that names neither.
  if (child.status !== 0) throw new Error(`probe child exited ${child.status}: ${child.error ?? child.stderr}`);
  return child.stdout.trim().split(/\r?\n/);
}

// Everything about where rg comes from runs in a child against a throwaway cache root. The cache
// is shared, persistent, machine-wide state — resolving it in this process would touch the
// developer's real one, and a test that renamed that binary would break any concurrent seri.
describe("rg resolution", () => {
  test("writes nothing until something actually searches", () => {
    // The whole point of the change: --version, login, logout and config never search, and used
    // to pay 5 429 760 bytes of extraction anyway.
    const [before, command] = runChild(
      [
        `const { existsSync } = await import("node:fs");`,
        IMPORT,
        `console.log(existsSync(${JSON.stringify(configDirIn(cacheRoot))}));`,
        `console.log(m.resolveRg());`,
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
      IMPORT,
      `console.log(m.resolveRg());`,
      `console.log(m.resolveRg());`,
      `console.log(statSync(m.resolveRg()).mtimeMs);`,
    ];
    const [firstCommand, secondCommand, firstMtime] = runChild(script, cacheEnv(cacheRoot));
    const [thirdCommand, , secondMtime] = runChild(script, cacheEnv(cacheRoot));

    expect(secondCommand).toBe(String(firstCommand));
    expect(thirdCommand).toBe(String(firstCommand));
    expect(secondMtime).toBe(String(firstMtime));
  }, 30_000);

  test("survives four processes populating one empty cache at once", async () => {
    // No lockfile, by design: every racer writes byte-identical bytes to its own pid-suffixed
    // temp name and renames, so last-writer-wins is indistinguishable from first. What this
    // checks is that nobody ever sees a half-written binary and nobody leaves a .tmp behind.
    const script = [IMPORT, `m.resolveRg();`].join("\n");
    const codes = await Promise.all(
      [0, 1, 2, 3].map(
        () =>
          new Promise<number | null>((resolve) => {
            const child = spawn(process.execPath, ["-e", script], { env: cacheEnv(cacheRoot), stdio: "ignore" });
            child.once("exit", resolve);
          }),
      ),
    );
    expect(codes).toEqual([0, 0, 0, 0]);

    const cacheDir = join(configDirIn(cacheRoot), "rg");
    const keyDir = join(cacheDir, String(readdirSync(cacheDir)[0]));
    expect(readdirSync(keyDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    const rg = join(keyDir, process.platform === "win32" ? "rg.exe" : "rg");
    expect(statSync(rg).size).toBe(statSync(ASSET).size);
    expect(spawnSync(rg, ["--version"], { encoding: "utf8" }).stdout).toContain("ripgrep");
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

  test.skipIf(process.platform === "win32")("repopulates a cached rg that lost its exec bit", () => {
    // Right size, wrong mode — what a home restored from a backup, an rsync without -p or a round
    // trip through exFAT leaves behind. Size alone would accept it, spawnSync would fail EACCES,
    // and since resolution never re-resolves that machine would be bricked for good. Windows has
    // no exec bit, so the branch this guards does not exist there.
    const [command] = runChild(RESOLVE, cacheEnv(cacheRoot));
    chmodSync(String(command), 0o644);

    const [again] = runChild(RESOLVE, cacheEnv(cacheRoot));

    expect(again).toBe(String(command));
    expect(statSync(String(again)).mode & 0o111).not.toBe(0);
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

  test("falls back to a temp copy of its own rg when the cache cannot be written", () => {
    // Every container and CI with a read-only or absent home takes this path — and LOCALAPPDATA
    // simply being unset is enough, since getConfigDir() throws on it outright. Pointed at a
    // regular file so the config dir is genuinely unusable rather than merely missing. seri keeps
    // searching, and keeps searching with the rg it vendored rather than an untested one off PATH.
    const root = join(tmpDir, "unwritable-file");
    writeFileSync(root, "not a directory");
    writeFileSync(join(tmpDir, "a.txt"), "needle\n");

    const [command, found, removed] = runChild(
      [
        `const { existsSync } = await import("node:fs");`,
        `const { dirname } = await import("node:path");`,
        IMPORT,
        `const rg = m.resolveRg();`,
        `console.log(rg);`,
        `console.log(m.runRipgrep(["--json", "needle", ${JSON.stringify(tmpDir)}]).stdout.includes("needle"));`,
        `process.on("exit", () => console.log(existsSync(dirname(rg))));`,
      ],
      cacheEnv(root),
    );

    expect(command).toContain("seri-rg-");
    expect(found).toBe("true");
    // Printed from a later 'exit' listener than the one that removes the directory: listeners run
    // in registration order, so this observes the state after cleanup rather than racing it.
    expect(removed).toBe("false");
  }, 30_000);

  test("names the cause when rg goes missing mid-session", () => {
    // The resolved rg can vanish while seri is running — an installer, a disk cleaner, an AV
    // quarantine. spawnSync then reports no status and no stderr, which the exit-code path
    // rendered as "rg exited with code undefined: null". Parking it after resolution is what
    // makes this a real test: resolution is memoized, so nothing silently re-populates it.
    const [message] = runChild(
      [
        `const { renameSync } = await import("node:fs");`,
        IMPORT,
        `const rg = m.resolveRg();`,
        `renameSync(rg, rg + ".parked");`,
        `try { m.runRipgrep(["--json", "needle", ${JSON.stringify(tmpDir)}]); console.log("no throw"); }`,
        `catch (error) { console.log(error.message); }`,
      ],
      cacheEnv(cacheRoot),
    );

    expect(message).toMatch(/failed to run rg/);
  }, 30_000);
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
