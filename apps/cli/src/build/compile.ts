import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

export function resolveBuildCommit(
  env: NodeJS.ProcessEnv = process.env,
  gitHead: () => string | undefined = readGitHead,
): string | undefined {
  const fromEnv = env.SERI_BUILD_COMMIT?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return gitHead();
}

export function opentuiLibcForCompile(
  target: string | undefined,
  platform: NodeJS.Platform,
): "glibc" | "musl" | undefined {
  if (target !== undefined && target.includes("musl")) return "musl";
  if (target !== undefined && target.includes("linux")) return "glibc";
  if ((target === undefined || target.length === 0) && platform === "linux") return "glibc";
  return undefined;
}

function linuxOpentuiNativeArch(target: string | undefined, hostArch: string): "x64" | "arm64" {
  if (target !== undefined && target.includes("arm64")) return "arm64";
  if (target !== undefined && target.includes("x64")) return "x64";
  return hostArch === "arm64" ? "arm64" : "x64";
}

export function linuxOpentuiNativePackage(
  target: string | undefined,
  platform: NodeJS.Platform,
  arch: string,
): string | undefined {
  const libc = opentuiLibcForCompile(target, platform);
  if (libc === undefined) return undefined;
  const cpu = linuxOpentuiNativeArch(target, arch);
  return `@opentui/core-linux-${cpu}${libc === "musl" ? "-musl" : ""}`;
}

export function stripPackedLinuxOpentuiNative(
  opts: {
    target?: string;
    platform?: NodeJS.Platform;
    arch?: string;
    resolveNative?: (packageName: string) => string | undefined;
    stripFile?: (soPath: string) => void;
  } = {},
): string | undefined {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const pkg = linuxOpentuiNativePackage(opts.target, platform, arch);
  if (pkg === undefined) return undefined;
  const so = (opts.resolveNative ?? defaultResolveNative)(pkg);
  if (so === undefined) return undefined;
  // bun --compile embeds the on-disk .so bytes. Strip before that spawn.
  // strip on the outer compiled ELF does not touch the packed payload.
  (opts.stripFile ?? defaultStripFile)(so);
  return so;
}

function defaultResolveNative(packageName: string): string | undefined {
  try {
    const req = createRequire(import.meta.resolve("@opentui/core"));
    const pkgJson = req.resolve(`${packageName}/package.json`);
    const so = join(dirname(pkgJson), "libopentui.so");
    return existsSync(so) ? so : undefined;
  } catch {
    return undefined;
  }
}

function defaultStripFile(soPath: string): void {
  const result = spawnSync("strip", ["-s", soPath], { encoding: "utf8" });
  if (result.error !== undefined) {
    throw new Error(`compile.ts: strip -s ${soPath} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`compile.ts: strip -s ${soPath} exited ${result.status}: ${result.stderr}`);
  }
}

export function compileArgs(opts: {
  entry: string;
  outfile: string;
  target?: string;
  commit?: string;
  platform?: NodeJS.Platform;
}): string[] {
  const args = ["build", "--compile", "--minify", opts.entry, "--outfile", opts.outfile];
  if (opts.target !== undefined && opts.target.length > 0) {
    args.push("--target", opts.target);
  }
  args.push("--define", `SERI_BAKED_HOSTED_ACCOUNTS=${JSON.stringify(false)}`);
  if (opts.commit !== undefined && opts.commit.length > 0) {
    args.push("--define", `SERI_BAKED_COMMIT=${JSON.stringify(opts.commit)}`);
  }
  const libc = opentuiLibcForCompile(opts.target, opts.platform ?? process.platform);
  if (libc !== undefined) {
    args.push("--define", `process.env.OPENTUI_LIBC=${JSON.stringify(libc)}`);
  }
  return args;
}

function readGitHead(): string | undefined {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      outfile: { type: "string" },
      target: { type: "string" },
      entry: { type: "string", default: "./src/cli.ts" },
    },
  });
  if (values.outfile === undefined) {
    console.error("compile.ts: --outfile is required");
    process.exit(2);
  }
  stripPackedLinuxOpentuiNative({ target: values.target });
  const result = spawnSync(
    process.execPath,
    compileArgs({
      entry: values.entry ?? "./src/cli.ts",
      outfile: values.outfile,
      target: values.target,
      commit: resolveBuildCommit(),
    }),
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}

if (import.meta.main) {
  main();
}
