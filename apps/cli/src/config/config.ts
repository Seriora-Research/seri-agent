import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./paths";

export function loadConfig(): Record<string, string> {
  const configPath = join(getConfigDir(), "config.json");
  if (!existsSync(configPath)) return {};
  const parsed = JSON.parse(readFileSync(configPath, "utf8"));
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

export function getApiKey(name: string): string | undefined {
  return process.env[name] ?? loadConfig()[name];
}
