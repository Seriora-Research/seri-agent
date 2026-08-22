import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../../..");
const FIXTURE = join(import.meta.dir, "fixtures/opentuiFfiFixture.ts");

const TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64"] as const;
type Target = (typeof TARGETS)[number];

// Only one of the 5 targets can actually be *run* on any given host -- the other 4 are
// compile-verified only (bun build --compile can cross-compile; a windows-x64 binary can't run on
// linux, etc.). Run this file on native Windows and inside WSL2 to run-verify the other one; the
// remaining 3 (whichever this host isn't) need CI or another machine.
function runnableTarget(): Target | undefined {
  if (process.platform === "win32" && process.arch === "x64") return "windows-x64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  return undefined;
}

// Opt-in, skip-by-default (mirrors nativeProviders.live.test.ts's exact shape): a plain
// `bun install` only fetches the host's own @opentui/core-<platform> optional dependency, so
// cross-compiling the other 4 targets first needs `--os=* --cpu=*` to pull every platform's
// native package onto disk -- real network/IO cost, not worth paying on every `bun test`. Set
// SERI_OPENTUI_FFI_SMOKE=1 to run it: meant to be re-run when @opentui/core is bumped, not on
// every commit.
describe.skipIf(process.env.SERI_OPENTUI_FFI_SMOKE !== "1")(
  "OpenTUI's native FFI module compiles and loads inside a `bun build --compile` binary",
  () => {
    test("all 5 build targets compile; the current host's own target also runs and loads the native module", () => {
      const install = spawnSync(process.execPath, ["install", "--os=*", "--cpu=*"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      expect(install.status, `bun install --os=* --cpu=* failed:\n${install.stderr}`).toBe(0);

      const dir = mkdtempSync(join(tmpdir(), "seri-opentui-ffi-"));
      const runnable = runnableTarget();
      try {
        for (const target of TARGETS) {
          const outfile = join(dir, `smoke-${target}${target === "windows-x64" ? ".exe" : ""}`);
          const build = spawnSync(
            process.execPath,
            ["build", "--compile", `--target=bun-${target}`, FIXTURE, "--outfile", outfile],
            { encoding: "utf8" },
          );
          expect(build.status, `compile failed for ${target}:\n${build.stderr}`).toBe(0);

          if (target !== runnable) continue;

          if (process.platform !== "win32") chmodSync(outfile, 0o755);
          const run = spawnSync(outfile, [], { encoding: "utf8" });
          // oven-sh/bun#30717's exact symptom: the native module fails to dlopen inside a
          // compiled binary even though the plain `bun run` (uncompiled) path works fine.
          expect(
            `${run.stdout}${run.stderr}`,
            `${target} binary failed to load its native module:\n${run.stderr}`,
          ).not.toContain("ERR_DLOPEN_FAILED");
          expect(run.status, `${target} binary exited non-zero:\n${run.stderr}`).toBe(0);
          expect(run.stdout).toContain("OPENTUI_FFI_OK");
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 300_000);
  },
);
