import { spawnSync } from "node:child_process";

const cache = new Map<string, string | undefined>();

function stripTrailingSep(path: string): string {
  if (/^[A-Za-z]:\\?$/.test(path) || path === "\\" || path === "/") return path;
  return path.replace(/[\\/]+$/, "");
}

function usableWinPath(path: string): string | undefined {
  const cleaned = stripTrailingSep(path.trim());
  if (cleaned.includes('"')) return undefined;
  if (!/^[A-Za-z]:[\\/]/.test(cleaned)) return undefined;
  return cleaned;
}

export function windowsShortPath(path: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  const native = usableWinPath(path.replaceAll("/", "\\"));
  if (native === undefined) return undefined;
  if (cache.has(native)) return cache.get(native);
  const result = spawnSync("cmd.exe", ["/d", "/s", "/c", `for %I in ("${native}") do @echo(%~sI`], {
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  if (result.status !== 0) {
    cache.set(native, undefined);
    return undefined;
  }
  const short = usableWinPath(result.stdout.trim().split(/\r?\n/).at(-1) ?? "");
  cache.set(native, short);
  return short;
}
