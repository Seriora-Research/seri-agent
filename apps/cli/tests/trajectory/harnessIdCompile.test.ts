import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "fixtures/harnessIdFixture.ts");
const COMPILE = join(import.meta.dir, "../../src/build/compile.ts");
const BAKED = "cafebabecafebabecafebabecafebabecafebabe";

function compileFixture(dir: string, define: string | undefined): string {
  const outfile = join(dir, process.platform === "win32" ? "harness-id.exe" : "harness-id");
  const args = ["build", "--compile", FIXTURE, "--outfile", outfile];
  if (define !== undefined) args.push("--define", define);
  const build = spawnSync(process.execPath, args, { encoding: "utf8" });
  expect(build.status, `compile failed:\n${build.stderr}`).toBe(0);
  if (process.platform !== "win32") chmodSync(outfile, 0o755);
  return outfile;
}

function runBinary(
  outfile: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): { stdout: string; status: number | null } {
  const run = spawnSync(outfile, [], {
    cwd,
    encoding: "utf8",
    env,
  });
  return { stdout: run.stdout, status: run.status };
}

function rmFixture(dir: string): void {
  // Windows still maps the compiled exe after spawnSync returns. force:true does not retry EBUSY.
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

describe("compiled harnessId", () => {
  test("a baked --define commit survives a non-repo cwd with no SERI_BUILD_COMMIT", () => {
    const dir = mkdtempSync(join(tmpdir(), "seri-harness-id-"));
    const cwd = mkdtempSync(join(dir, "not-a-repo-"));
    try {
      const outfile = compileFixture(dir, `SERI_BAKED_COMMIT=${JSON.stringify(BAKED)}`);
      const env = { ...process.env };
      delete env.SERI_BUILD_COMMIT;
      const run = runBinary(outfile, cwd, env);
      expect(run.status, run.stdout).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({
        version: expect.any(String),
        commit: BAKED,
      });
    } finally {
      rmFixture(dir);
    }
  }, 60_000);

  test("without --define, a non-repo cwd and no env omits commit — the compiled-binary gap", () => {
    const dir = mkdtempSync(join(tmpdir(), "seri-harness-id-neg-"));
    const cwd = mkdtempSync(join(dir, "not-a-repo-"));
    try {
      const outfile = compileFixture(dir, undefined);
      const env = { ...process.env };
      delete env.SERI_BUILD_COMMIT;
      const run = runBinary(outfile, cwd, env);
      expect(run.status, run.stdout).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ version: expect.any(String) });
    } finally {
      rmFixture(dir);
    }
  }, 60_000);

  test("compile.ts bakes git HEAD so a non-repo cwd still reports that commit", () => {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(sha).toMatch(/^[0-9a-f]{40}$/i);
    const dir = mkdtempSync(join(tmpdir(), "seri-harness-id-script-"));
    const cwd = mkdtempSync(join(dir, "not-a-repo-"));
    try {
      const outfile = join(dir, process.platform === "win32" ? "harness-id.exe" : "harness-id");
      const compileEnv = { ...process.env };
      delete compileEnv.SERI_BUILD_COMMIT;
      const build = spawnSync(
        process.execPath,
        [COMPILE, "--entry", FIXTURE, "--outfile", outfile],
        { encoding: "utf8", env: compileEnv },
      );
      expect(build.status, `compile.ts failed:\n${build.stderr}\n${build.stdout}`).toBe(0);
      if (process.platform !== "win32") chmodSync(outfile, 0o755);
      const env = { ...process.env };
      delete env.SERI_BUILD_COMMIT;
      const run = runBinary(outfile, cwd, env);
      expect(run.status, run.stdout).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({
        version: expect.any(String),
        commit: sha,
      });
    } finally {
      rmFixture(dir);
    }
  }, 60_000);

  test("runtime SERI_BUILD_COMMIT overrides the baked commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "seri-harness-id-ovr-"));
    const cwd = mkdtempSync(join(dir, "not-a-repo-"));
    try {
      const outfile = compileFixture(dir, `SERI_BAKED_COMMIT=${JSON.stringify(BAKED)}`);
      const run = runBinary(outfile, cwd, { ...process.env, SERI_BUILD_COMMIT: "abc123" });
      expect(run.status, run.stdout).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({
        version: expect.any(String),
        commit: "abc123",
      });
    } finally {
      rmFixture(dir);
    }
  }, 60_000);
});
