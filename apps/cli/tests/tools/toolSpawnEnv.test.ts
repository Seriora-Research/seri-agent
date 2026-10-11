import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBashAvailable, runBash } from "../../src/tools/bash";
import { spawnCollect } from "../../src/tools/spawnCollect";
import { ToolSpawnEnv } from "../../src/tools/toolSpawnEnv";

describe("ToolSpawnEnv", () => {
  test("JSON.stringify, spread and inspect do not reveal the variables", () => {
    const env = ToolSpawnEnv.exactly({ FOO: "secret", PATH: "/bin" });
    expect(JSON.stringify(env)).toBe("{}");
    expect({ ...env }).toEqual({});
    expect(Bun.inspect(env)).not.toContain("secret");
    expect(Bun.inspect(env)).not.toContain("FOO");
    expect(Bun.inspect(env)).toContain("ToolSpawnEnv");
  });

  test("spawnOptions copies replace vars and omits env when inheriting", () => {
    expect(ToolSpawnEnv.inherited.spawnOptions()).toEqual({});
    const vars = { FOO: "b", PATH: "/bin" };
    const options = ToolSpawnEnv.exactly(vars).spawnOptions();
    expect(options.env).toEqual(vars);
    expect(options.env).not.toBe(vars);
    if (options.env !== undefined) options.env.FOO = "mutated";
    expect(ToolSpawnEnv.exactly(vars).spawnOptions().env).toEqual(vars);
  });

  test("a ToolSpawnEnv is not spawnCollect's io argument", () => {
    type SpawnIo = string | { stdin?: string; fd3?: string };
    type Assert<T extends true> = T;
    type _EnvIsNotIo = Assert<ToolSpawnEnv extends SpawnIo ? false : true>;
    const _keep: _EnvIsNotIo = true;
    expect(_keep).toBe(true);
  });
});

describe.skipIf(!isBashAvailable())("spawnCollect env", () => {
  const originalFoo = process.env.FOO;

  function restoreFoo(): void {
    if (originalFoo === undefined) delete process.env.FOO;
    else process.env.FOO = originalFoo;
  }

  test("replace, not merge: the child sees the given FOO and not the parent's", async () => {
    process.env.FOO = "daemon-a";
    process.env.ONLY_IN_PARENT = "leak";
    try {
      const result = await spawnCollect(
        "bash",
        ["-c", "printf '%s\\n%s' \"$FOO\" \"${ONLY_IN_PARENT-unset}\""],
        15000,
        undefined,
        undefined,
        undefined,
        ToolSpawnEnv.exactly({ FOO: "b", PATH: process.env.PATH ?? "/usr/bin:/bin" }),
      );
      expect(result.stdout).toBe("b\nunset");
      expect(process.env.FOO).toBe("daemon-a");
      expect(process.env.ONLY_IN_PARENT).toBe("leak");
    } finally {
      restoreFoo();
      delete process.env.ONLY_IN_PARENT;
    }
  }, 15000);

  test("inherit still sees the parent FOO", async () => {
    process.env.FOO = "daemon-a";
    try {
      const result = await spawnCollect(
        "bash",
        ["-c", "printf '%s' \"$FOO\""],
        15000,
        undefined,
        undefined,
        undefined,
        ToolSpawnEnv.inherited,
      );
      expect(result.stdout).toBe("daemon-a");
    } finally {
      restoreFoo();
    }
  }, 15000);

  test("a replace map without FOO prints an empty FOO", async () => {
    process.env.FOO = "daemon-a";
    try {
      const result = await spawnCollect(
        "bash",
        ["-c", "printf '%s' \"$FOO\""],
        15000,
        undefined,
        undefined,
        undefined,
        ToolSpawnEnv.exactly({ PATH: process.env.PATH ?? "/usr/bin:/bin" }),
      );
      expect(result.stdout).toBe("");
    } finally {
      restoreFoo();
    }
  }, 15000);
});

describe.skipIf(process.platform === "win32" || !isBashAvailable())("runBash env", () => {
  const originalFoo = process.env.FOO;

  test("bash in a client env prints FOO and the given cwd", async () => {
    process.env.FOO = "daemon-a";
    const work = mkdtempSync(join(tmpdir(), "seri-spawn-env-"));
    try {
      const result = await runBash(
        "echo $FOO; pwd",
        15000,
        undefined,
        isBashAvailable,
        work,
        ToolSpawnEnv.exactly({ FOO: "b", PATH: process.env.PATH ?? "/usr/bin:/bin" }),
      );
      expect(result.stdout).toBe(`b\n${realpathSync(work)}\n`);
      expect(process.env.FOO).toBe("daemon-a");
    } finally {
      rmSync(work, { recursive: true, force: true });
      if (originalFoo === undefined) delete process.env.FOO;
      else process.env.FOO = originalFoo;
    }
  }, 15000);
});
