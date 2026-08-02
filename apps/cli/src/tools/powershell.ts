import { type ProcessResult, spawnCollect } from "./spawnCollect";

export function runPowerShell(command: string): Promise<ProcessResult> {
  return spawnCollect("powershell.exe", ["-NonInteractive", "-NoProfile", "-Command", command]);
}
