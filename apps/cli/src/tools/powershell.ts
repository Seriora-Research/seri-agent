import { clearEolCache } from "./eolCache";
import { type ProcessResult, spawnCollect } from "./spawnCollect";

export async function runPowerShell(
  command: string,
  timeoutMs?: number,
  signal?: AbortSignal,
  cwd?: string,
): Promise<ProcessResult> {
  try {
    return await spawnCollect(
      "powershell.exe",
      ["-NonInteractive", "-NoProfile", "-Command", command],
      timeoutMs,
      signal,
      cwd,
    );
  } finally {
    clearEolCache();
  }
}
