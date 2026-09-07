import { execFileSync } from "node:child_process";
import pkg from "../../package.json";
import { gitArgv } from "../checkpoint/gitArgv";





declare const SERI_BAKED_COMMIT: string | undefined;

export function readBakedCommit(): string | undefined {
  const baked = typeof SERI_BAKED_COMMIT === "string" ? SERI_BAKED_COMMIT.trim() : "";
  return baked.length > 0 ? baked : undefined;
}

export function harnessId(
  env: NodeJS.ProcessEnv = process.env,
  gitHead: () => string | undefined = readGitHead,
  baked: string | undefined = readBakedCommit(),
): { version: string; commit?: string } {
  const fromEnv = env.SERI_BUILD_COMMIT?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return { version: pkg.version, commit: fromEnv };
  }
  const fromBaked = baked?.trim();
  if (fromBaked !== undefined && fromBaked.length > 0) {
    return { version: pkg.version, commit: fromBaked };
  }
  const fromGit = gitHead();
  return fromGit === undefined
    ? { version: pkg.version }
    : { version: pkg.version, commit: fromGit };
}

export function readGitHead(): string | undefined {
  try {
    const sha = execFileSync("git", gitArgv(["rev-parse", "HEAD"]), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}
