import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export function findCodexBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.SERI_CODEX_BIN;
  if (override !== undefined && override.length > 0) return override;

  const pathEnv = env.PATH ?? env.Path;
  if (pathEnv === undefined || pathEnv.length === 0) return undefined;
  const names =
    process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex.bat", "codex"] : ["codex"];
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export type CodexSpawnTarget = {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

function quoteCmdPath(command: string): string {
  return `"${command.replace(/"/g, '""')}"`;
}





export function resolveCodexSpawn(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): CodexSpawnTarget {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const rest = args
      .map((arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg))
      .join(" ");
    const line = rest.length > 0 ? `${quoteCmdPath(command)} ${rest}` : quoteCmdPath(command);
    return { command: "cmd.exe", args: ["/d", "/s", "/c", line], windowsVerbatimArguments: true };
  }
  return { command, args: [...args] };
}

export type CodexSetupStatus =
  | { status: "not-connected" }
  | { status: "connected"; planType?: string }
  | { status: "ignored" };

export function describeCodexSetupStatus(status: CodexSetupStatus): string {
  switch (status.status) {
    case "not-connected":
      return "not connected";
    case "connected":
      return status.planType === undefined ? "connected" : `connected — ${status.planType}`;
    case "ignored":
      return "ignored";
  }
}
