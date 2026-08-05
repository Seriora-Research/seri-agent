import { type ProcessResult, spawnCollect } from "./spawnCollect";

export function runPowerShell(command: string, timeoutMs?: number, signal?: AbortSignal): Promise<ProcessResult> {
  return spawnCollect("powershell.exe", ["-NonInteractive", "-NoProfile", "-Command", command], timeoutMs, signal);
}
