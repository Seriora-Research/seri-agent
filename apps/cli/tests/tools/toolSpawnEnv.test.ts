import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { _resetBashResolutionForTests, isBashAvailable, runBash } from "../../src/tools/bash";
import { spawnCollect } from "../../src/tools/spawnCollect";
import { ToolSpawnEnv } from "../../src/tools/toolSpawnEnv";

const CLIENT_BASH_MARKER = "seri-client-bash-280";
const CLIENT_BASH_BODY = `#!/bin/sh\necho ${CLIENT_BASH_MARKER}\n`;

function daemonLookupMustNotRun(): string {
  throw new Error("daemon lookup must not run");
}

function writeClientBash(dir: string, mode: number): string {
  const name = process.platform === "win32" ? "bash.exe" : "bash";
  const file = join(dir, name);
  writeFileSync(file, CLIENT_BASH_BODY);
  chmodSync(file, mode);
  return file;
}

function pathWithWrapperFirst(wrapperDir: string): string {
  return `${wrapperDir}${delimiter}${process.env.PATH ?? ""}`;
}

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

  test("inherited resolveExecutable returns the daemon lookup", () => {
    expect(ToolSpawnEnv.inherited.resolveExecutable("bash", () => "/daemon/bash")).toBe(
      "/daemon/bash",
    );
  });

  test("exactly resolveExecutable returns the bash on the snapshot PATH", () => {
    const bin = mkdtempSync(join(tmpdir(), "seri-client-bash-"));
    try {
      const bash = writeClientBash(bin, 0o755);
      expect(
        ToolSpawnEnv.exactly({ PATH: bin }).resolveExecutable("bash", daemonLookupMustNotRun),
      ).toBe(bash);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test("exactly with no PATH throws when bash is not on the client's PATH", () => {
    expect(() =>
      ToolSpawnEnv.exactly({}).resolveExecutable("bash", daemonLookupMustNotRun),
    ).toThrow("bash is not on the client's PATH");
  });

  test("exactly resolveExecutable searches powershell.exe", () => {
    const bin = mkdtempSync(join(tmpdir(), "seri-client-pwsh-"));
    try {
      const file = join(bin, "powershell.exe");
      writeFileSync(file, "not a shell\n");
      chmodSync(file, 0o755);
      expect(
        ToolSpawnEnv.exactly({ PATH: bin }).resolveExecutable(
          "powershell",
          daemonLookupMustNotRun,
        ),
      ).toBe(file);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test("a PATH entry that is a file is skipped", () => {
    const root = mkdtempSync(join(tmpdir(), "seri-client-bash-"));
    const wrapperDir = mkdtempSync(join(tmpdir(), "seri-client-bash-"));
    const asFile = join(root, "not-a-dir");
    try {
      writeFileSync(asFile, "not a directory\n");
      const bash = writeClientBash(wrapperDir, 0o755);
      expect(
        ToolSpawnEnv.exactly({ PATH: `${asFile}${delimiter}${wrapperDir}` }).resolveExecutable(
          "bash",
          daemonLookupMustNotRun,
        ),
      ).toBe(bash);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(wrapperDir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("an unreadable PATH directory is skipped", () => {
    const locked = mkdtempSync(join(tmpdir(), "seri-client-bash-locked-"));
    const wrapperDir = mkdtempSync(join(tmpdir(), "seri-client-bash-"));
    try {
      const bash = writeClientBash(wrapperDir, 0o755);
      chmodSync(locked, 0o000);
      expect(
        ToolSpawnEnv.exactly({ PATH: `${locked}${delimiter}${wrapperDir}` }).resolveExecutable(
          "bash",
          daemonLookupMustNotRun,
        ),
      ).toBe(bash);
    } finally {
      chmodSync(locked, 0o755);
      rmSync(locked, { recursive: true, force: true });
      rmSync(wrapperDir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "win32" || !isBashAvailable())("spawnCollect env", () => {
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
        ["-c", 'printf "%s\\n" "$FOO"; printenv ONLY_IN_PARENT >/dev/null; echo $?'],
        15000,
        undefined,
        undefined,
        undefined,
        ToolSpawnEnv.exactly({ FOO: "b", PATH: process.env.PATH ?? "/usr/bin:/bin" }),
      );
      expect(result.stdout).toBe("b\n1\n");
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

describe.skipIf(process.platform === "win32" || !isBashAvailable())("client PATH bash", () => {
  test("a snapshot hit does not pin the daemon's bash", async () => {
    _resetBashResolutionForTests();
    const wrapperDir = mkdtempSync(join(tmpdir(), "seri-client-bash-"));
    try {
      writeClientBash(wrapperDir, 0o755);
      const marked = await runBash(
        "echo daemon",
        undefined,
        undefined,
        undefined,
        ToolSpawnEnv.exactly({ PATH: pathWithWrapperFirst(wrapperDir) }),
      );
      expect(marked.stdout).toBe(`${CLIENT_BASH_MARKER}\n`);
      const inherited = await runBash("echo hi");
      expect(inherited.stdout.trim()).toBe("hi");
    } finally {
      _resetBashResolutionForTests();
      rmSync(wrapperDir, { recursive: true, force: true });
    }
  }, 15000);

  test("Path is not PATH on POSIX", () => {
    const wrapperDir = mkdtempSync(join(tmpdir(), "seri-client-bash-"));
    try {
      writeClientBash(wrapperDir, 0o755);
      expect(() =>
        ToolSpawnEnv.exactly({ Path: wrapperDir }).resolveExecutable(
          "bash",
          daemonLookupMustNotRun,
        ),
      ).toThrow("bash is not on the client's PATH");
    } finally {
      rmSync(wrapperDir, { recursive: true, force: true });
    }
  });

  test("a relative PATH entry is not searched", async () => {
    const work = mkdtempSync(join(tmpdir(), "seri-client-bash-"));
    const originalCwd = process.cwd();
    try {
      writeClientBash(work, 0o755);
      process.chdir(work);
      await expect(
        runBash("echo daemon", undefined, undefined, work, ToolSpawnEnv.exactly({ PATH: "." })),
      ).rejects.toThrow("bash is not on the client's PATH");
    } finally {
      process.chdir(originalCwd);
      rmSync(work, { recursive: true, force: true });
    }
  }, 15000);

  test("a non-executable bash is skipped", async () => {
    const noexecDir = mkdtempSync(join(tmpdir(), "seri-client-bash-noexec-"));
    const wrapperDir = mkdtempSync(join(tmpdir(), "seri-client-bash-"));
    try {
      const stub = join(noexecDir, "bash");
      writeFileSync(stub, "not a shell\n");
      chmodSync(stub, 0o644);
      writeClientBash(wrapperDir, 0o755);
      const result = await runBash(
        "echo daemon",
        undefined,
        undefined,
        undefined,
        ToolSpawnEnv.exactly({ PATH: `${noexecDir}${delimiter}${wrapperDir}` }),
      );
      expect(result.stdout).toBe(`${CLIENT_BASH_MARKER}\n`);
    } finally {
      rmSync(noexecDir, { recursive: true, force: true });
      rmSync(wrapperDir, { recursive: true, force: true });
    }
  }, 15000);
});
