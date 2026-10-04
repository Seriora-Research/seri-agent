import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";

const SHORT_COMPONENT = /~[0-9]/i;

const cache = new Map<string, string>();

export function hasWindowsShortName(path: string): boolean {
  return process.platform === "win32" && SHORT_COMPONENT.test(path);
}

export function expandWindowsShortNames(path: string): string {
  if (!hasWindowsShortName(path)) return path;
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  const expanded = expandViaItem(path) ?? expandViaParent(path);
  cache.set(path, expanded);
  return expanded;
}

function expandViaParent(path: string): string {
  const parent = dirname(path);
  const base = basename(path);
  if (parent === path) return path;
  return join(expandWindowsShortNames(parent), base);
}

function expandViaItem(path: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  const result = spawnSync(
    "powershell.exe",
    [
      "-NonInteractive",
      "-NoProfile",
      "-Command",
      "try { (Get-Item -LiteralPath $env:SERI_WIN32_EXPAND).FullName } catch { exit 1 }",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, SERI_WIN32_EXPAND: path },
    },
  );
  if (result.status !== 0) return undefined;
  const line = result.stdout.trim().split(/\r?\n/).at(-1)?.trim();
  if (line === undefined || line.length === 0) return undefined;
  return line;
}
