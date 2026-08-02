import { homedir } from "node:os";
import { join } from "node:path";

export function getConfigDir(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) throw new Error("LOCALAPPDATA environment variable is not set");
    return join(localAppData, "hesper");
  }
  return join(process.env.HOME || homedir(), ".hesper");
}
