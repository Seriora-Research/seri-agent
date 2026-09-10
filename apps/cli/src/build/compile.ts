import { execFileSync, spawnSync } from "node:child_process";
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
