import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export class ToolSpawnEnv {
  static readonly inherited: ToolSpawnEnv = new ToolSpawnEnv(undefined);

  static exactly(vars: Readonly<Record<string, string>>): ToolSpawnEnv {
    return new ToolSpawnEnv(Object.freeze({ ...vars }));
  }

  readonly #vars: Readonly<Record<string, string>> | undefined;

  private constructor(vars: Readonly<Record<string, string>> | undefined) {
    this.#vars = vars;
  }

  spawnOptions(): { env?: Record<string, string> } {
    return this.#vars === undefined ? {} : { env: { ...this.#vars } };
  }

  resolveExecutable(name: "bash" | "powershell", daemonLookup: () => string): string {
    if (this.#vars === undefined) return daemonLookup();
    const found = findOnClientPath(name, clientPathValue(this.#vars));
    if (found === undefined) throw new Error(`${name} is not on the client's PATH`);
    return found;
  }
}

// `Path` is a different variable on POSIX. On win32 a snapshot may spell the key
// either way, and `PATH` wins when that exact key is present.
function clientPathValue(vars: Readonly<Record<string, string>>): string | undefined {
  if (process.platform !== "win32") return vars.PATH;
  if (vars.PATH !== undefined) return vars.PATH;
  const key = Object.keys(vars).find((entry) => entry.toUpperCase() === "PATH");
  return key === undefined ? undefined : vars[key];
}

// A relative entry is the child's cwd. Searching it would stat the daemon's cwd,
// or a bash planted in the turn cwd.
function findOnClientPath(
  name: "bash" | "powershell",
  pathValue: string | undefined,
): string | undefined {
  if (pathValue === undefined) return undefined;
  const names = process.platform === "win32" ? [`${name}.exe`, name] : [name];
  for (const dir of pathValue.split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    for (const candidate of names.map((fileName) => join(dir, fileName))) {
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

// A non-executable file makes spawn fail with EACCES instead of moving on.
function isExecutableFile(path: string): boolean {
  if (statSync(path, { throwIfNoEntry: false })?.isFile() !== true) return false;
  if (process.platform === "win32") return true;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
