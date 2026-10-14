import { clearEolCache } from "./eolCache";
import { type ProcessResult, spawnCollect } from "./spawnCollect";
import { ToolSpawnEnv } from "./toolSpawnEnv";

export async function runPowerShell(
  command: string,
  timeoutMs?: number,
  signal?: AbortSignal,
  cwd?: string,
  env: ToolSpawnEnv = ToolSpawnEnv.inherited,
): Promise<ProcessResult> {
  const powershell = env.resolveExecutable("powershell", () => "powershell.exe");
  try {
    return await spawnCollect(
      powershell,
      ["-NonInteractive", "-NoProfile", "-Command", command],
      timeoutMs,
      signal,
      cwd,
      undefined,
      env,
    );
  } finally {
    clearEolCache();
  }
}
