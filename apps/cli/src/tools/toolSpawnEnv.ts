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

  get(name: string): string | undefined {
    const vars = this.#vars ?? process.env;
    if (!Object.hasOwn(vars, name)) return undefined;
    const value = vars[name];
    return typeof value === "string" ? value : undefined;
  }

  resolveExecutable(name: "bash" | "powershell", daemonLookup: () => string): string {
    if (this.#vars === undefined) return daemonLookup();
    let pathValue = this.get("PATH");
    if (pathValue === undefined && process.platform === "win32") {
      const key = Object.keys(this.#vars).find((entry) => entry.toUpperCase() === "PATH");
      pathValue = key === undefined ? undefined : this.get(key);
    }
    const found = findOnClientPath(name, pathValue);
    if (found === undefined) throw new Error(`${name} is not on the client's PATH`);
    return found;
  }
}

function findOnClientPath(
  name: "bash" | "powershell",
  pathValue: string | undefined,
): string | undefined {
  if (pathValue === undefined) return undefined;
  const names =
    name === "powershell"
      ? ["powershell.exe"]
      : process.platform === "win32"
        ? ["bash.exe", "bash"]
        : ["bash"];
  for (const dir of pathValue.split(delimiter).filter(isAbsolute)) {
    for (const candidate of names.map((fileName) => join(dir, fileName))) {
      if (isSpawnableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function isSpawnableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform === "win32") return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
