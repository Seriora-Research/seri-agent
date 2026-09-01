import { execFileSync, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

// Build-time source for the identifier `harnessId` reads after a compile.
// `SERI_BUILD_COMMIT` here chooses what to bake; at runtime the same env
// var is an override of the baked value, not this lookup.
export function resolveBuildCommit(
  env: NodeJS.ProcessEnv = process.env,
  gitHead: () => string | undefined = readGitHead,
): string | undefined {
  const fromEnv = env.SERI_BUILD_COMMIT?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return gitHead();
}

export function compileArgs(opts: {
  entry: string;
  outfile: string;
  target?: string;
  commit?: string;
}): string[] {
  const args = ["build", "--compile", opts.entry, "--outfile", opts.outfile];
  if (opts.target !== undefined && opts.target.length > 0) {
    args.push("--target", opts.target);
  }
  if (opts.commit !== undefined && opts.commit.length > 0) {
    args.push("--define", `SERI_BAKED_COMMIT=${JSON.stringify(opts.commit)}`);
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
