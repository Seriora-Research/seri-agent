import { dlopen, FFIType, ptr } from "bun:ffi";
import { basename, dirname, join } from "node:path";

const SHORT_COMPONENT = /~[0-9]/i;

let loaded:
  | ((
      shortPath: ReturnType<typeof ptr>,
      longPath: ReturnType<typeof ptr>,
      buffer: number,
    ) => number)
  | "missing"
  | undefined;

function getLongPathNameW():
  | ((
      shortPath: ReturnType<typeof ptr>,
      longPath: ReturnType<typeof ptr>,
      buffer: number,
    ) => number)
  | undefined {
  if (loaded === "missing") return undefined;
  if (loaded !== undefined) return loaded;
  if (process.platform !== "win32") {
    loaded = "missing";
    return undefined;
  }
  try {
    const lib = dlopen("kernel32.dll", {
      GetLongPathNameW: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
        returns: FFIType.u32,
      },
    });
    loaded = lib.symbols.GetLongPathNameW;
    return loaded;
  } catch {
    loaded = "missing";
    return undefined;
  }
}

function toWide(path: string): Uint16Array {
  const out = new Uint16Array(path.length + 1);
  for (let i = 0; i < path.length; i++) out[i] = path.charCodeAt(i);
  return out;
}

function fromWide(buf: Uint16Array, chars: number): string {
  return Buffer.from(buf.buffer, buf.byteOffset, chars * 2).toString("utf16le");
}

function queryLongPath(path: string): string | undefined {
  const fn = getLongPathNameW();
  if (fn === undefined) return undefined;
  const input = toWide(path);
  const first = new Uint16Array(8);
  const needed = fn(ptr(input), ptr(first), first.length);
  if (needed === 0) return undefined;
  const output = new Uint16Array(needed + 1);
  const written = fn(ptr(input), ptr(output), output.length);
  if (written === 0 || written >= output.length) return undefined;
  return fromWide(output, written);
}

export function hasWindowsShortName(path: string): boolean {
  return process.platform === "win32" && SHORT_COMPONENT.test(path);
}

export function expandWindowsShortNames(path: string): string {
  if (!hasWindowsShortName(path)) return path;
  const direct = queryLongPath(path);
  if (direct !== undefined) return direct;
  const parent = dirname(path);
  const base = basename(path);
  if (parent === path) return path;
  return join(expandWindowsShortNames(parent), base);
}
