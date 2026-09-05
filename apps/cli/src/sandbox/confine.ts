import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export function probeConfinement(
  platform: NodeJS.Platform = process.platform,
  which: (bin: string) => boolean = binOnPath,
): boolean {
  if (platform === "linux") return which("bwrap");
  if (platform === "darwin") return which("sandbox-exec");
  return false;
}

function binOnPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? "").split(delimiter);
  const names = process.platform === "win32" ? [`${bin}.exe`, bin] : [bin];
  for (const dir of dirs) {
    for (const name of names) {
      if (existsSync(join(dir, name))) return true;
    }
  }
  return false;
}
