import { join } from "node:path";
import { loadConfig, setConfigValue, unsetConfigValue } from "./config";

const USAGE = `Usage:
  hesper config set <KEY> <VALUE>
  hesper config list
  hesper config unset <KEY>`;

// Values are provider API keys — show just enough to identify which key is stored without
// printing it in full, since `config list` output tends to end up in screenshots and issues.
export function maskValue(value: string): string {
  if (value.length <= 12) return "*".repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function configCommand(args: string[], configDir: string): number {
  const [subcommand, key, value] = args;

  if (subcommand === "set") {
    // An empty value would persist a key that `config list` shows as present but every
    // reader treats as unset — reject it rather than storing that contradiction.
    if (!key || !value) {
      console.error(USAGE);
      return 1;
    }
    setConfigValue(key, value, configDir);
    console.log(`Saved ${key} to ${join(configDir, "config.json")}`);
    return 0;
  }

  if (subcommand === "list") {
    const config = loadConfig(configDir);
    const keys = Object.keys(config).sort();
    if (keys.length === 0) {
      console.log(`No values set in ${join(configDir, "config.json")}`);
      return 0;
    }
    for (const k of keys) {
      // Flag env-var shadowing explicitly: getApiKey prefers process.env, so a stored value
      // that is being overridden would otherwise look like the one in effect.
      const shadowed = process.env[k] !== undefined ? "  (overridden by env var)" : "";
      console.log(`${k} = ${maskValue(config[k])}${shadowed}`);
    }
    return 0;
  }

  if (subcommand === "unset") {
    if (!key) {
      console.error(USAGE);
      return 1;
    }
    console.log(unsetConfigValue(key, configDir) ? `Removed ${key}` : `${key} was not set`);
    return 0;
  }

  console.error(USAGE);
  return 1;
}
