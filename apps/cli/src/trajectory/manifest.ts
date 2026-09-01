import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { execFileSync } from "node:child_process";
import pkg from "../../package.json";
import { findAgentsFile } from "../agents/loadAgentsFile";
import { loadReasoningEffortConfig, loadConfig } from "../config/config";
import { getConfigDir } from "../config/paths";
import type { ModelProvider } from "@seri/model-catalog";
import { loadSamplingConfig, resolveSampling, type SamplingRecord } from "../provider/sampling";
import type { RouteCredential } from "../provider/routing";

export type ContextFileHash = { path: string; sha256: string };

export type TrajectoryManifest = {
  harness: { version: string; commit?: string };
  upstreamProvider: string | null;
  temperature: SamplingRecord;
  seed: SamplingRecord;
  reasoningEffort: string | null;
  maxIterations: number;
  context: ContextFileHash[];
};

export function harnessId(
  env: NodeJS.ProcessEnv = process.env,
  gitHead: () => string | undefined = readGitHead,
): { version: string; commit?: string } {
  const fromEnv = env.SERI_BUILD_COMMIT?.trim();
  const commit = fromEnv && fromEnv.length > 0 ? fromEnv : gitHead();
  return commit === undefined ? { version: pkg.version } : { version: pkg.version, commit };
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

export function hashContextFile(path: string, cwd: string): ContextFileHash | undefined {
  if (!existsSync(path)) return undefined;
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  const rel = relative(cwd, path);
  return { path: rel === "" ? path : rel, sha256 };
}

export function collectContextFiles(opts: {
  cwd: string;
  rules?: Iterable<{ filePath: string }>;
  skills?: Iterable<{ filePath: string }>;
}): string[] {
  const files = new Set<string>();
  const agents = findAgentsFile(opts.cwd);
  if (agents !== undefined) files.add(agents);
  if (opts.rules !== undefined) {
    for (const rule of opts.rules) files.add(rule.filePath);
  }
  if (opts.skills !== undefined) {
    for (const skill of opts.skills) files.add(skill.filePath);
  }
  return [...files].sort();
}

export function hashContextFiles(paths: readonly string[], cwd: string): ContextFileHash[] {
  return paths.flatMap((path) => {
    const hashed = hashContextFile(path, cwd);
    return hashed === undefined ? [] : [hashed];
  });
}

export function buildRunManifest(opts: {
  cwd: string;
  configDir?: string;
  provider?: ModelProvider;
  credential?: RouteCredential;
  contextFiles?: readonly string[];
  maxIterations: number;
  env?: NodeJS.ProcessEnv;
  gitHead?: () => string | undefined;
}): TrajectoryManifest {
  const configDir = opts.configDir ?? getConfigDir();
  const configured = loadSamplingConfig(configDir);
  const sampling = resolveSampling(opts.provider, opts.credential, configured);
  const pin = configured.openRouterPin;
  return {
    harness: harnessId(opts.env ?? process.env, opts.gitHead ?? readGitHead),
    upstreamProvider: pin === undefined ? null : pin.join(","),
    temperature: sampling.temperatureRecord,
    seed: sampling.seedRecord,
    reasoningEffort: loadReasoningEffortConfig(loadConfig(configDir)) ?? null,
    maxIterations: opts.maxIterations,
    context: hashContextFiles(opts.contextFiles ?? collectContextFiles({ cwd: opts.cwd }), opts.cwd),
  };
}
