import { homedir } from "node:os";
import { join } from "node:path";

export function getBaseConfigDir(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) throw new Error("LOCALAPPDATA environment variable is not set");
    return join(localAppData, "seri");
  }
  return join(process.env.HOME || homedir(), ".seri");
}

// Temporary pass-through, replaced with the profile-aware body in a later step of this change.
export function getConfigDir(): string {
  return getBaseConfigDir();
}
