import { isBashAvailable, runBash } from "../tools/bash";
import { runPowerShell } from "../tools/powershell";
import type { ProcessResult } from "../tools/spawnCollect";
import type { SandboxTier, ShellLaunch } from "./policy";

export const BANG_USAGE = "usage: ! <command>  (example: ! ls)";

export type BangSink = {
  error: (message: string) => void;
  output: (text: string) => void;
};

export type BangRunners = {
  sandboxed: (command: string, root: string, signal?: AbortSignal) => Promise<ProcessResult>;
  unsandboxed: (command: string, cwd: string, signal?: AbortSignal) => Promise<ProcessResult>;
};

export async function executeBang(
  command: string,
  launch: ShellLaunch,
  runners: BangRunners,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ declared: SandboxTier; result?: ProcessResult; refused?: string }> {
  if (launch.kind === "refused") {
    return { declared: launch.declared, refused: launch.reason };
  }
  if (launch.kind === "sandboxed") {
    return {
      declared: launch.declared,
      result: await runners.sandboxed(command, launch.root, signal),
    };
  }
  return {
    declared: launch.declared,
    result: await runners.unsandboxed(command, cwd, signal),
  };
}

export async function runHostShell(
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  if (isBashAvailable()) return runBash(command, undefined, signal, isBashAvailable, cwd);
  if (process.platform === "win32") return runPowerShell(command, undefined, signal, cwd);
  throw new Error("bash is not available on this system");
}

export function defaultBangRunners(): BangRunners {
  return {
    sandboxed: async () => {
      throw new Error("OS sandbox runner is not installed");
    },
    unsandboxed: runHostShell,
  };
}

export async function submitBang(
  command: string,
  launch: ShellLaunch,
  runners: BangRunners,
  cwd: string,
  sink: BangSink,
  signal?: AbortSignal,
): Promise<void> {
  if (command.length === 0) {
    sink.error(BANG_USAGE);
    return;
  }
  const executed = await executeBang(command, launch, runners, cwd, signal);
  if (executed.refused !== undefined) {
    sink.error(executed.refused);
    return;
  }
  const result = executed.result;
  if (result === undefined) return;
  const body = [result.stdout, result.stderr].filter((s) => s.length > 0).join("\n");
  sink.output(body.length > 0 ? body : `(exit ${result.exitCode})`);
}
