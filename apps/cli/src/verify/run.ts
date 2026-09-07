import { resolve } from "node:path";
import { spawnCollect as spawnCollectReal } from "../tools/spawnCollect";
import type { CheckOutcome } from "./outcome";
import { parseDiagnostics } from "./parse";




export type { CheckOutcome } from "./outcome";




export const MAX_DIAGNOSTICS = 20;



const RAW_TAIL_CHARS = 600;

export type RunCheckOptions = { spawn?: typeof spawnCollectReal };

function tail(text: string): string {
  return text.length > RAW_TAIL_CHARS ? text.slice(-RAW_TAIL_CHARS) : text;
}



export async function runCheck(
  command: string | undefined,
  writtenPath: string,
  signal: AbortSignal | undefined,
  options: RunCheckOptions = {},
): Promise<CheckOutcome> {
  if (command === undefined) {
    return {
      status: "unavailable",
      reason: "no check command configured (set SERI_VERIFY_COMMAND)",
    };
  }





  const [executable, ...args] = command.trim().split(/\s+/);




  const startedAt = Date.now();

  let result;
  try {
    result = await (options.spawn ?? spawnCollectReal)(executable, args, undefined, signal);
  } catch (err) {



    return {
      status: "failed",
      reason: `${command} could not be run: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const elapsedMs = Date.now() - startedAt;








  const all = parseDiagnostics(`${result.stdout}\n${result.stderr}`);

  if (all.length === 0) {
    if (result.timedOut)
      return { status: "failed", reason: `${command} timed out after ${elapsedMs} ms` };
    if (result.exitCode === 0) return { status: "ok", command, elapsedMs };
    return {
      status: "failed",
      reason: `${command} exited ${result.exitCode} with no output this parser could read: ${tail(result.stderr || result.stdout)}`,
    };
  }









  const writtenAbsolute = resolve(writtenPath);
  const here = all.filter((diagnostic) => resolve(diagnostic.file) === writtenAbsolute);
  const elsewhere = all.filter((diagnostic) => resolve(diagnostic.file) !== writtenAbsolute);

  return {
    status: "diagnostics",
    command,
    elapsedMs,
    diagnostics: [...here, ...elsewhere].slice(0, MAX_DIAGNOSTICS),
    inWrittenFile: Math.min(here.length, MAX_DIAGNOSTICS),



    truncated: result.stdoutTruncated || result.stderrTruncated || result.timedOut,
    total: all.length,
  };
}
