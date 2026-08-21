import { clearEolCache } from "./eolCache";
import { type ProcessResult, spawnCollect } from "./spawnCollect";

export async function runPowerShell(
  command: string,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  try {
    return await spawnCollect(
      "powershell.exe",
      ["-NonInteractive", "-NoProfile", "-Command", command],
      timeoutMs,
      signal,
    );
  } finally {
    // See bash.ts's runBash: a command can touch any file, so the whole cache is dropped rather
    // than trusting whatever it held before this call ran.
    clearEolCache();
  }
}
