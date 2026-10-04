import { spawnSync } from "node:child_process";

const cache = new Map<string, string | undefined>();

export function windowsShortPath(path: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  if (cache.has(path)) return cache.get(path);
  if (path.includes('"')) {
    cache.set(path, undefined);
    return undefined;
  }
  const result = spawnSync("cmd.exe", ["/c", `for %I in ("${path}") do @echo %~sI`], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    cache.set(path, undefined);
    return undefined;
  }
  const short = result.stdout.trim().split(/\r?\n/).at(-1)?.trim();
  if (short === undefined || short.length === 0) {
    cache.set(path, undefined);
    return undefined;
  }
  cache.set(path, short);
  return short;
}
