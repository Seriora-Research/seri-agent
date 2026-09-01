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

export type CodexSetupStatus =
  | { status: "not-installed" }
  | { status: "not-logged-in"; reason: "no-auth" | "api-key" }
  | { status: "connected" };

export function describeCodexSetupStatus(status: CodexSetupStatus): string {
  switch (status.status) {
    case "not-installed":
      return "not installed";
    case "not-logged-in":
      return status.reason === "api-key"
        ? "API-key login. Run `codex login`"
        : "run `codex login`";
    case "connected":
      return "ChatGPT plan connected";
  }
}

export function codexSetupAction(status: CodexSetupStatus): string {
  switch (status.status) {
    case "not-installed":
      return "Codex CLI is not installed. Install it, then run `codex login`. seri reuses that login and identifies as seri on the wire.";
    case "not-logged-in":
      return status.reason === "api-key"
        ? "Codex is logged in with an API key, not a ChatGPT plan. Run `codex login` to attach the plan."
        : "Codex is installed but not logged in. Run `codex login` to attach your ChatGPT plan.";
    case "connected":
      return "Using your ChatGPT plan via Codex. Turns are included in the plan. seri identifies as seri; it does not host the login or store a client id.";
  }
}
