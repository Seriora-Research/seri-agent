import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pkg from "../../package.json";
import { getBaseConfigDir } from "../../src/config/paths";
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

function cacheEnv(root: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: root };
}

function configDirIn(root: string): string {
  const original = process.env.HOME;
  process.env.HOME = root;
  try {
    return getBaseConfigDir();
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
  }
}

// pgrep -f <rgPath> matches any rg on the box; the search dir is unique to this process.
function rgPidFor(dir: string): number | undefined {
  const line =
    spawnSync("pgrep", ["-f", dir], { encoding: "utf8" }).stdout.trim().split("\n")[0] ?? "";
  const pid = Number.parseInt(line, 10);
  return Number.isInteger(pid) ? pid : undefined;
}

async function waitForRgPid(dir: string, budgetMs: number): Promise<number> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const pid = rgPidFor(dir);
    if (pid !== undefined) return pid;
    if (Date.now() >= deadline) throw new Error(`no rg was searching ${dir} within ${budgetMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// rg finishes a 200 MB tree in ~150 ms and does not block on a FIFO; a 2 GiB sparse file with -a stays alive long enough to observe.
function slowSearchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const big = join(dir, "big.bin");
  writeFileSync(big, "");
  truncateSync(big, 2 * 1024 * 1024 * 1024);
  return dir;
}

const SLOW_SEARCH_ARGS = ["-a", "--files-with-matches", "--", "needle"];

function runChild(script: string[], env: NodeJS.ProcessEnv): string[] {
  const child = spawnSync(process.execPath, ["-e", script.join("\n")], { encoding: "utf8", env });
  if (child.status !== 0)
    throw new Error(`probe child exited ${child.status}: ${child.error ?? child.stderr}`);
  return child.stdout.trim().split(/\r?\n/);
}

describe("rg resolution", () => {
  test("writes nothing until something actually searches", () => {
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
    const script = [IMPORT, `m.resolveRg();`].join("\n");
    const codes = await Promise.all(
      [0, 1, 2, 3].map(
        () =>
          new Promise<number | null>((resolve) => {
            const child = spawn(process.execPath, ["-e", script], {
              env: cacheEnv(cacheRoot),
              stdio: "ignore",
            });
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
    const [command] = runChild(RESOLVE, cacheEnv(cacheRoot));
    writeFileSync(String(command), "not really rg");

    const [again] = runChild(RESOLVE, cacheEnv(cacheRoot));

    expect(again).toBe(String(command));
    expect(statSync(String(again)).size).toBe(statSync(ASSET).size);
  }, 30_000);

  test.skipIf(process.platform === "win32")(
    "repopulates a cached rg that lost its exec bit",
    () => {
      // exFAT/rsync-without-p strips the exec bit; Windows has none, so this branch does not exist there.
      const [command] = runChild(RESOLVE, cacheEnv(cacheRoot));
      chmodSync(String(command), 0o644);

      const [again] = runChild(RESOLVE, cacheEnv(cacheRoot));

      expect(again).toBe(String(command));
      expect(statSync(String(again)).mode & 0o111).not.toBe(0);
    },
    30_000,
  );

  test("keys the cache so a different seri or a different rg cannot reuse it", () => {
    const [command] = runChild(RESOLVE, cacheEnv(cacheRoot));
    const cacheDir = join(configDirIn(cacheRoot), "rg");
    expect(readdirSync(cacheDir)).toEqual([
      `${pkg.version}-${process.platform}-${process.arch}-${statSync(ASSET).size}`,
    ]);

    const foreign = join(cacheDir, "0.0.0-otherplatform-otherarch-1");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "rg"), "another seri's rg");

    const [again] = runChild(RESOLVE, cacheEnv(cacheRoot));

    expect(again).toBe(String(command));
    expect(statSync(join(foreign, "rg")).size).toBe("another seri's rg".length);
  }, 30_000);

  test("SERI_PROFILE does not change where the shared rg cache lives", () => {
    const [withoutProfile] = runChild(RESOLVE, cacheEnv(cacheRoot));
    const [withProfile] = runChild(RESOLVE, { ...cacheEnv(cacheRoot), SERI_PROFILE: "work" });

    expect(withProfile).toBe(withoutProfile);
    expect(() => readdirSync(join(configDirIn(cacheRoot), "work"))).toThrow();
  }, 30_000);

  test("falls back to a temp copy of its own rg when the cache cannot be written", () => {
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
        `console.log((await m.runRipgrep(["--json", "needle", ${JSON.stringify(tmpDir)}])).stdout.includes("needle"));`,
        `process.on("exit", () => console.log(existsSync(dirname(rg))));`,
      ],
      cacheEnv(root),
    );

    expect(command).toContain("seri-rg-");
    expect(found).toBe("true");
    expect(removed).toBe("false");
  }, 30_000);

  test("names the cause when rg goes missing mid-session", () => {
    const [message] = runChild(
      [
        `const { renameSync } = await import("node:fs");`,
        IMPORT,
        `const rg = m.resolveRg();`,
        `renameSync(rg, rg + ".parked");`,
        `try { await m.runRipgrep(["--json", "needle", ${JSON.stringify(tmpDir)}]); console.log("no throw"); }`,
        `catch (error) { console.log(error.message); }`,
      ],
      cacheEnv(cacheRoot),
    );

    expect(message).toMatch(/failed to run rg/);
  }, 30_000);
});

describe("runRipgrep", () => {
  test("returns stdout and reports no truncation for an ordinary search", async () => {
    writeFileSync(join(tmpDir, "a.txt"), "needle\n");

    const { stdout, truncated } = await runRipgrep(["--json", "needle", tmpDir]);

    expect(truncated).toBe(false);
    expect(stdout).toContain("needle");
  });

  test("reports truncation instead of throwing when rg outruns the stdout buffer", async () => {
    writeFileSync(join(tmpDir, "big.txt"), "needle here on this line\n".repeat(60_000));

    const { stdout, truncated } = await runRipgrep(["--json", "needle", tmpDir]);

    expect(truncated).toBe(true);
    expect(stdout.length).toBeGreaterThan(0);
  });

  test("still throws when rg genuinely fails", async () => {
    await expect(runRipgrep(["--definitely-not-a-real-flag", tmpDir])).rejects.toThrow(
      /rg exited with code/,
    );
  });

  test("caps stderr instead of throwing the whole stream on a failed search", async () => {
    writeFileSync(join(tmpDir, "a.txt"), "needle\n");
    // Windows CreateProcess rejects a 50k argument.
    const patternFile = join(tmpDir, "pattern.txt");
    writeFileSync(patternFile, `[${"x".repeat(50_000)}`);
    try {
      await runRipgrep(["--json", "-f", patternFile, tmpDir]);
      throw new Error("expected runRipgrep to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toMatch(/rg exited with code 2/);
      expect(message.length).toBeLessThan(32_000);
    }
  });

  test.skipIf(process.platform === "win32")(
    "a stderr flood does not forfeit a truncated page of matches",
    async () => {
      writeFileSync(join(tmpDir, "big.txt"), "needle here on this line\n".repeat(60_000));
      for (let i = 0; i < 600; i++) {
        const dir = join(tmpDir, `denied_${i}`);
        mkdirSync(dir);
        chmodSync(dir, 0);
      }
      try {
        const { stdout, truncated } = await runRipgrep(["--json", "needle", tmpDir]);
        expect(truncated).toBe(true);
        expect(stdout.length).toBeGreaterThan(0);
        expect(stdout).toContain("needle");
      } finally {
        for (let i = 0; i < 600; i++) {
          try {
            chmodSync(join(tmpDir, `denied_${i}`), 0o700);
          } catch {}
        }
      }
    },
  );

  test("ignores the user's own ripgrep config", async () => {
    writeFileSync(join(tmpDir, "a.txt"), "needle\n");
    const configPath = join(tmpDir, "ripgreprc");
    writeFileSync(configPath, "--glob=!*.txt\n");

    const original = process.env.RIPGREP_CONFIG_PATH;
    process.env.RIPGREP_CONFIG_PATH = configPath;
    try {
      const { stdout } = await runRipgrep(["--json", "needle", tmpDir]);
      expect(stdout).toContain("needle");
    } finally {
      // Assigning undefined to process.env sets the string "undefined".
      if (original === undefined) delete process.env.RIPGREP_CONFIG_PATH;
      else process.env.RIPGREP_CONFIG_PATH = original;
    }
  });

  test.skipIf(process.platform === "win32")(
    "a cancelled search is killed rather than run to completion",
    async () => {
      const dir = slowSearchDir("seri-rg-cancel-");

      const controller = new AbortController();
      const search = runRipgrep([...SLOW_SEARCH_ARGS, dir], controller.signal);
      // A rejection with no listener is an unhandled rejection, not this test's result.
      const outcome = search.then(
        () => "resolved",
        (err: Error) => `rejected: ${err.message}`,
      );
      const settledWithin = (ms: number): Promise<string> =>
        Promise.race([
          outcome,
          new Promise<string>((r) => setTimeout(() => r("still searching"), ms)),
        ]);

      try {
        const rgPid = await waitForRgPid(dir, 20_000);
        expect(await settledWithin(0)).toBe("still searching");

        controller.abort();

        expect(await settledWithin(5_000)).toBe("rejected: cancelled");

        // kill(pid, 0) succeeds on a zombie until init reaps it.
        const deadline = Date.now() + 5_000;
        while (isAlive(rgPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
        expect(isAlive(rgPid) ? `rg ${rgPid} survived the cancel` : "killed").toBe("killed");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    45_000,
  );

  test.skipIf(process.platform === "win32")(
    "kills an in-flight search when a signal ends the run",
    async () => {
      const dir = slowSearchDir("seri-rg-signal-");
      // Directory goes in env so pgrep -f dir cannot match this parent process's argv.
      const script =
        `const m = await import(${JSON.stringify(MODULE)});` +
        `m.runRipgrep([${SLOW_SEARCH_ARGS.map((a) => JSON.stringify(a)).join(", ")}, process.env.SERI_TEST_DIR]).catch(() => {});`;
      const child = spawn(process.execPath, ["-e", script], {
        stdio: "ignore",
        env: { ...process.env, SERI_TEST_DIR: dir },
      });

      try {
        const rgPid = await waitForRgPid(dir, 20_000);

        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));

        // kill(pid, 0) succeeds on a zombie until init reaps it.
        const deadline = Date.now() + 5_000;
        while (isAlive(rgPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
        expect(isAlive(rgPid) ? `rg ${rgPid} survived SIGTERM` : "killed").toBe("killed");
      } finally {
        child.kill("SIGKILL");
        // process.kill throws ESRCH if the survivor was already reaped.
        const survivor = rgPidFor(dir);
        if (survivor !== undefined) {
          try {
            process.kill(survivor, "SIGKILL");
          } catch {}
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
    45_000,
  );
});
