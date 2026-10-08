import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUN_COMPILE_UUID_DARWIN_ARM64, stampMachOUuid } from "../../src/build/machoUuid";
import { inspectConfig } from "../../src/config/config";
import {
  getConfigDir,
  getDaemonLockPath,
  getMemoriesDir,
  setProfileOverride,
} from "../../src/config/paths";
import { runDoctorChecks } from "../../src/doctor/checks";
import { doctorExitCode, formatDoctorReport } from "../../src/doctor/report";
import { DATABASE_FILENAME, SessionDatabase } from "../../src/session/database";
import { thinMachO } from "../build/thinMachO";

function asFetch(fn: () => Promise<never>): typeof fetch {
  return fn as unknown as typeof fetch;
}

const originalHome = process.env.HOME;
const originalGroq = process.env.GROQ_API_KEY;
const originalDisableFetch = process.env.SERI_DISABLE_MODELS_FETCH;

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

const dirs: string[] = [];

afterEach(() => {
  setProfileOverride(undefined);
  restoreEnv("HOME", originalHome);
  restoreEnv("GROQ_API_KEY", originalGroq);
  restoreEnv("SERI_DISABLE_MODELS_FETCH", originalDisableFetch);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "seri-doctor-"));
  dirs.push(dir);
  process.env.HOME = dir;
  setProfileOverride(undefined);
  return dir;
}

function plantToolStdout(configDir: string, sessionId: string, cwd: string, token: string): void {
  mkdirSync(configDir, { recursive: true });
  const database = new SessionDatabase(configDir);
  try {
    database.saveSession({
      id: sessionId,
      cwd,
      systemPrompt: "",
      permissionMode: "approve-each",
      messages: [{ role: "user", content: "hi" }],
    });
  } finally {
    database.close();
  }
  const raw = new Database(join(configDir, DATABASE_FILENAME));
  raw.query("UPDATE messages SET json = ?").run(
    JSON.stringify({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          output: { type: "json", value: { stdout: token } },
        },
      ],
    }),
  );
  raw.close();
}

function quietDoctorDeps(configDir: string) {
  return {
    grep: async () => ({
      mode: "content" as const,
      matches: [{ file: "probe.txt", line: 1, text: "seri selftest probe" }],
      truncated: false,
    }),
    fetch: asFetch(async () => {
      throw new Error("doctor must not fetch");
    }),
    execPath: "/usr/bin/bun",
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    configDir,
  };
}

describe("formatDoctorReport", () => {
  test("prints status, name, detail, and a fix on the next line", () => {
    const text = formatDoctorReport([
      { name: "binary", status: "ok", detail: "seri 0.1.0" },
      {
        name: "credentials",
        status: "fail",
        detail: "no BYOK keys",
        fix: "run seri and complete /setup",
      },
    ]);
    expect(text).toContain("ok   binary");
    expect(text).toContain("fail credentials");
    expect(text).toContain("run seri and complete /setup");
    expect(doctorExitCode([{ name: "binary", status: "ok", detail: "x" }])).toBe(0);
    expect(
      doctorExitCode([
        { name: "binary", status: "ok", detail: "x" },
        { name: "credentials", status: "fail", detail: "y" },
      ]),
    ).toBe(1);
    expect(doctorExitCode([{ name: "git", status: "warn", detail: "missing" }])).toBe(0);
  });
});

describe("runDoctorChecks", () => {
  test("fails credentials with no keys and does not create seri.db", async () => {
    tempHome();
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.XAI_API_KEY;
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
    const configDir = getConfigDir();
    const checks = await runDoctorChecks({
      grep: async () => ({
        mode: "content",
        matches: [{ file: "probe.txt", line: 1, text: "seri selftest probe" }],
        truncated: false,
      }),
      fetch: asFetch(async () => {
        throw new Error("doctor must not fetch");
      }),
      execPath: "/usr/bin/bun",
      env: process.env,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
      configDir,
    });
    const credentials = checks.find((check) => check.name === "credentials");
    expect(credentials?.status).toBe("fail");
    expect(checks.find((check) => check.name === "sessions")?.detail).toContain("absent");
    expect(checks.find((check) => check.name === "secrets")?.detail).toContain("absent");
    expect(checks.find((check) => check.name === "catalog")?.detail).toContain("disabled");
    expect(doctorExitCode(checks)).toBe(1);
  });

  test("fails when config.json is not JSON", async () => {
    tempHome();
    process.env.GROQ_API_KEY = "fake-test-key";
    const configDir = getConfigDir();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), "{nope");
    expect(inspectConfig(configDir).status).toBe("malformed");
    const checks = await runDoctorChecks({
      grep: async () => ({
        mode: "content",
        matches: [{ file: "probe.txt", line: 1, text: "seri selftest probe" }],
        truncated: false,
      }),
      fetch: asFetch(async () => {
        throw new Error("doctor must not fetch");
      }),
      execPath: "/usr/bin/bun",
      env: process.env,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
      configDir,
    });
    expect(checks.find((check) => check.name === "config")?.status).toBe("fail");
  });

  test("fails permissions when a deny entry is not a string, naming deny[index]", async () => {
    tempHome();
    process.env.GROQ_API_KEY = "fake-test-key";
    const configDir = getConfigDir();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "permissions.yaml"),
      "global: []\nprojects: {}\ndeny:\n  - read_file(.env)\n  - path: /tmp/secret\n",
    );
    const checks = await runDoctorChecks({
      grep: async () => ({
        mode: "content",
        matches: [{ file: "probe.txt", line: 1, text: "seri selftest probe" }],
        truncated: false,
      }),
      fetch: asFetch(async () => {
        throw new Error("doctor must not fetch");
      }),
      execPath: "/usr/bin/bun",
      env: process.env,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
      configDir,
    });
    const permissions = checks.find((check) => check.name === "permissions");
    expect(permissions?.status).toBe("fail");
    expect(permissions?.detail).toContain("deny[1]");
    expect(permissions?.fix).toContain("do not delete");
  });

  test("names deny[index] even when a grant warning is also present", async () => {
    tempHome();
    process.env.GROQ_API_KEY = "fake-test-key";
    const configDir = getConfigDir();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "permissions.yaml"),
      "global:\n  - bash\nprojects: {}\ndeny:\n  - read_file(.env)\n  - path: /tmp/secret\n",
    );
    const checks = await runDoctorChecks({
      grep: async () => ({
        mode: "content",
        matches: [{ file: "probe.txt", line: 1, text: "seri selftest probe" }],
        truncated: false,
      }),
      fetch: asFetch(async () => {
        throw new Error("doctor must not fetch");
      }),
      execPath: "/usr/bin/bun",
      env: process.env,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
      configDir,
    });
    const permissions = checks.find((check) => check.name === "permissions");
    expect(permissions?.status).toBe("fail");
    expect(permissions?.detail).toContain("deny[1]");
    expect(permissions?.detail).not.toContain("bash");
    expect(permissions?.fix).toContain("do not delete");
  });

  test("passes credentials when a BYOK key is set", async () => {
    tempHome();
    process.env.GROQ_API_KEY = "fake-test-key";
    const checks = await runDoctorChecks({
      grep: async () => ({
        mode: "content",
        matches: [{ file: "probe.txt", line: 1, text: "seri selftest probe" }],
        truncated: false,
      }),
      fetch: asFetch(async () => {
        throw new Error("doctor must not fetch");
      }),
      execPath: "/usr/bin/bun",
      env: process.env,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
    });
    expect(checks.find((check) => check.name === "credentials")?.status).toBe("ok");
    expect(checks.find((check) => check.name === "credentials")?.detail).toContain("groq=env:");
  });

  test("warns on Linux when the io_uring probe reports allow", async () => {
    tempHome();
    process.env.GROQ_API_KEY = "fake-test-key";
    const checks = await runDoctorChecks({
      grep: async () => ({
        mode: "content",
        matches: [{ file: "probe.txt", line: 1, text: "seri selftest probe" }],
        truncated: false,
      }),
      fetch: asFetch(async () => {
        throw new Error("doctor must not fetch");
      }),
      execPath: "/usr/bin/bun",
      env: process.env,
      platform: "linux",
      arch: "x64",
      cwd: process.cwd(),
      probeIoUring: () => ({ status: "allow" }),
    });
    const ioUring = checks.find((check) => check.name === "io_uring");
    expect(ioUring).toBeDefined();
    if (ioUring === undefined) return;
    expect(ioUring.status).toBe("warn");
    expect(ioUring.detail).toContain("io_uring_setup");
    expect(ioUring.detail).toContain("io_uring_enter");
    expect(ioUring.detail).toContain("io_uring_register");
    expect(doctorExitCode([ioUring])).toBe(0);
  });

  test("reports io_uring as info on darwin", async () => {
    tempHome();
    process.env.GROQ_API_KEY = "fake-test-key";
    const checks = await runDoctorChecks({
      grep: async () => ({
        mode: "content",
        matches: [{ file: "probe.txt", line: 1, text: "seri selftest probe" }],
        truncated: false,
      }),
      fetch: asFetch(async () => {
        throw new Error("doctor must not fetch");
      }),
      execPath: "/usr/bin/bun",
      env: process.env,
      platform: "darwin",
      arch: "arm64",
      cwd: process.cwd(),
      probeIoUring: () => ({ status: "allow" }),
    });
    expect(checks.find((check) => check.name === "io_uring")?.status).toBe("info");
  });

  test("fails on Linux when the io_uring probe errors", async () => {
    tempHome();
    process.env.GROQ_API_KEY = "fake-test-key";
    const checks = await runDoctorChecks({
      grep: async () => ({
        mode: "content",
        matches: [{ file: "probe.txt", line: 1, text: "seri selftest probe" }],
        truncated: false,
      }),
      fetch: asFetch(async () => {
        throw new Error("doctor must not fetch");
      }),
      execPath: "/usr/bin/bun",
      env: process.env,
      platform: "linux",
      arch: "x64",
      cwd: process.cwd(),
      probeIoUring: () => ({ status: "error", message: "dlopen failed" }),
    });
    const ioUring = checks.find((check) => check.name === "io_uring");
    expect(ioUring).toBeDefined();
    if (ioUring === undefined) return;
    expect(ioUring.status).toBe("fail");
    expect(ioUring.detail).toBe("dlopen failed");
    expect(doctorExitCode([ioUring])).toBe(1);
  });

  test("includes a sandbox row that names the declared bang tier", async () => {
    tempHome();
    process.env.GROQ_API_KEY = "fake-test-key";
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
    const checks = await runDoctorChecks({
      grep: async () => ({
        mode: "content",
        matches: [{ file: "probe.txt", line: 1, text: "seri selftest probe" }],
        truncated: false,
      }),
      fetch: asFetch(async () => {
        throw new Error("doctor must not fetch");
      }),
      execPath: "/usr/bin/bun",
      env: process.env,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
    });
    const sandbox = checks.find((check) => check.name === "sandbox");
    expect(sandbox).toBeDefined();
    expect(sandbox?.detail).toMatch(/base|os|unsandboxed/);
    expect(sandbox?.detail).toContain("bang");
  });

  test("warns about a residual tool-result token and --scrub replaces it without echoing the value", async () => {
    const home = tempHome();
    process.env.GROQ_API_KEY = "fake-test-key";
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
    const configDir = getConfigDir();
    const token = `ghp_${"A".repeat(20)}B9Qx`;
    plantToolStdout(configDir, "historic", home, token);
    const deps = quietDoctorDeps(configDir);

    const warned = await runDoctorChecks(deps);
    const secrets = warned.find((check) => check.name === "secrets");
    expect(secrets?.status).toBe("warn");
    expect(secrets?.detail).toContain("github-pat");
    expect(secrets?.detail).not.toContain(token);
    expect(JSON.stringify(warned)).not.toContain(token);

    const scrubbed = await runDoctorChecks({ ...deps, scrub: true });
    const after = scrubbed.find((check) => check.name === "secrets");
    expect(after?.status).toBe("ok");
    expect(after?.detail).toContain("replaced");
    expect(JSON.stringify(scrubbed)).not.toContain(token);
    const loaded = new SessionDatabase(configDir);
    try {
      expect(JSON.stringify(loaded.loadSession("historic"))).not.toContain(token);
    } finally {
      loaded.close();
    }
  });

  test("refuses --scrub while the daemon lock is held and does not rewrite", async () => {
    const home = tempHome();
    process.env.GROQ_API_KEY = "fake-test-key";
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
    const configDir = getConfigDir();
    const token = `ghp_${"A".repeat(20)}B9Qx`;
    plantToolStdout(configDir, "locked", home, token);
    writeFileSync(getDaemonLockPath(configDir), "1\n");

    const checks = await runDoctorChecks({ ...quietDoctorDeps(configDir), scrub: true });
    const secrets = checks.find((check) => check.name === "secrets");
    expect(secrets?.status).toBe("fail");
    expect(secrets?.detail).toContain("daemon lock");
    expect(JSON.stringify(checks)).not.toContain(token);
    const loaded = new SessionDatabase(configDir);
    try {
      expect(JSON.stringify(loaded.loadSession("locked"))).toContain(token);
    } finally {
      loaded.close();
    }
  });

  test("warns about a residual memory-file token and --scrub replaces it without echoing the value", async () => {
    tempHome();
    process.env.GROQ_API_KEY = "fake-test-key";
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
    const configDir = getConfigDir();
    const token = `ghp_${"A".repeat(20)}B9Qx`;
    const memoryPath = join(getMemoriesDir(configDir), "USER.md");
    mkdirSync(getMemoriesDir(configDir), { recursive: true });
    writeFileSync(memoryPath, `- [2026-08-11] deploy with ${token}\n`);
    const deps = quietDoctorDeps(configDir);

    const warned = await runDoctorChecks(deps);
    const secrets = warned.find((check) => check.name === "secrets");
    expect(secrets?.status).toBe("warn");
    expect(secrets?.detail).toContain("github-pat");
    expect(secrets?.detail).not.toContain(token);
    expect(JSON.stringify(warned)).not.toContain(token);
    expect(readFileSync(memoryPath, "utf8")).toContain(token);

    const scrubbed = await runDoctorChecks({ ...deps, scrub: true });
    const after = scrubbed.find((check) => check.name === "secrets");
    expect(after?.status).toBe("ok");
    expect(after?.detail).toContain("replaced");
    expect(JSON.stringify(scrubbed)).not.toContain(token);
    const cleaned = readFileSync(memoryPath, "utf8");
    expect(cleaned).toContain("[redacted:github-pat:B9Qx]");
    expect(cleaned).not.toContain(token);
  });

  test("scrubs a project MEMORY.md without deleting sibling entries after a PEM header", async () => {
    tempHome();
    process.env.GROQ_API_KEY = "fake-test-key";
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
    const configDir = getConfigDir();
    const projectDir = join(getMemoriesDir(configDir), "aaaaaaaaaaaaaaaa");
    mkdirSync(projectDir, { recursive: true });
    const memoryPath = join(projectDir, "MEMORY.md");
    writeFileSync(
      memoryPath,
      [
        "- [2026-08-11] starts with -----BEGIN OPENSSH PRIVATE KEY-----",
        "- [2026-08-11] uses bun test",
      ].join("\n"),
    );
    const deps = quietDoctorDeps(configDir);
    const scrubbed = await runDoctorChecks({ ...deps, scrub: true });
    const secrets = scrubbed.find((check) => check.name === "secrets");
    expect(secrets?.status).toBe("ok");
    expect(secrets?.detail).toContain("replaced");
    const after = readFileSync(memoryPath, "utf8");
    expect(after).toContain("[redacted:private-key]");
    expect(after).toContain("uses bun test");
    expect(after).not.toContain("BEGIN OPENSSH");
  });

  test("a memories path that is a file does not crash doctor", async () => {
    tempHome();
    process.env.GROQ_API_KEY = "fake-test-key";
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
    const configDir = getConfigDir();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(getMemoriesDir(configDir), "not a directory");
    const checks = await runDoctorChecks(quietDoctorDeps(configDir));
    const secrets = checks.find((check) => check.name === "secrets");
    expect(secrets).toBeDefined();
    expect(secrets?.status).not.toBe("fail");
  });

  test("scrubs memory files when seri.db cannot be opened", async () => {
    tempHome();
    process.env.GROQ_API_KEY = "fake-test-key";
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
    const configDir = getConfigDir();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, DATABASE_FILENAME), "not a sqlite database");
    const token = `ghp_${"A".repeat(20)}B9Qx`;
    const memoryPath = join(getMemoriesDir(configDir), "USER.md");
    mkdirSync(getMemoriesDir(configDir), { recursive: true });
    writeFileSync(memoryPath, `- [2026-08-11] deploy with ${token}\n`);
    const scrubbed = await runDoctorChecks({ ...quietDoctorDeps(configDir), scrub: true });
    const secrets = scrubbed.find((check) => check.name === "secrets");
    expect(secrets?.detail).toContain("replaced");
    expect(secrets?.detail).toContain("github-pat");
    expect(JSON.stringify(scrubbed)).not.toContain(token);
    expect(readFileSync(memoryPath, "utf8")).toContain("[redacted:github-pat:B9Qx]");
    expect(readFileSync(memoryPath, "utf8")).not.toContain(token);
  });

  test("reports unreadable memory files on the replaced path", async () => {
    tempHome();
    process.env.GROQ_API_KEY = "fake-test-key";
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
    const configDir = getConfigDir();
    const token = `ghp_${"A".repeat(20)}B9Qx`;
    mkdirSync(getMemoriesDir(configDir), { recursive: true });
    writeFileSync(
      join(getMemoriesDir(configDir), "USER.md"),
      `- [2026-08-11] deploy with ${token}\n`,
    );
    mkdirSync(join(getMemoriesDir(configDir), "MEMORY.md"));
    const scrubbed = await runDoctorChecks({ ...quietDoctorDeps(configDir), scrub: true });
    const secrets = scrubbed.find((check) => check.name === "secrets");
    expect(secrets?.status).toBe("warn");
    expect(secrets?.detail).toContain("replaced");
    expect(secrets?.detail).toContain("unreadable");
    expect(JSON.stringify(scrubbed)).not.toContain(token);
  });

  test("omits macho_uuid on linux", async () => {
    tempHome();
    process.env.GROQ_API_KEY = "fake-test-key";
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
    const checks = await runDoctorChecks({
      grep: async () => ({
        mode: "content",
        matches: [{ file: "probe.txt", line: 1, text: "seri selftest probe" }],
        truncated: false,
      }),
      fetch: asFetch(async () => {
        throw new Error("doctor must not fetch");
      }),
      execPath: "/usr/bin/seri",
      env: process.env,
      platform: "linux",
      arch: "x64",
      cwd: process.cwd(),
    });
    expect(checks.find((check) => check.name === "macho_uuid")).toBeUndefined();
  });

  test("omits macho_uuid for a source bun path on darwin", async () => {
    tempHome();
    process.env.GROQ_API_KEY = "fake-test-key";
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
    const checks = await runDoctorChecks({
      grep: async () => ({
        mode: "content",
        matches: [{ file: "probe.txt", line: 1, text: "seri selftest probe" }],
        truncated: false,
      }),
      fetch: asFetch(async () => {
        throw new Error("doctor must not fetch");
      }),
      execPath: "/usr/bin/bun",
      env: process.env,
      platform: "darwin",
      arch: "arm64",
      cwd: process.cwd(),
      probeIoUring: () => ({ status: "allow" }),
    });
    expect(checks.find((check) => check.name === "macho_uuid")).toBeUndefined();
  });

  test("fails macho_uuid when a compiled darwin seri still has the bun stub", async () => {
    tempHome();
    process.env.GROQ_API_KEY = "fake-test-key";
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
    const dir = mkdtempSync(join(tmpdir(), "seri-doctor-bin-"));
    dirs.push(dir);
    const execPath = join(dir, "seri");
    writeFileSync(execPath, thinMachO(BUN_COMPILE_UUID_DARWIN_ARM64, Buffer.from("stub")));
    const checks = await runDoctorChecks({
      grep: async () => ({
        mode: "content",
        matches: [{ file: "probe.txt", line: 1, text: "seri selftest probe" }],
        truncated: false,
      }),
      fetch: asFetch(async () => {
        throw new Error("doctor must not fetch");
      }),
      execPath,
      env: process.env,
      platform: "darwin",
      arch: "arm64",
      cwd: process.cwd(),
      probeIoUring: () => ({ status: "allow" }),
    });
    const uuid = checks.find((check) => check.name === "macho_uuid");
    expect(uuid?.status).toBe("fail");
    expect(uuid?.detail).toContain(BUN_COMPILE_UUID_DARWIN_ARM64);
    expect(uuid?.detail).toContain("shared by bun-compiled binaries");
    if (uuid === undefined) return;
    expect(doctorExitCode([uuid])).toBe(1);
  });

  test("fails macho_uuid for a bun 1.3 stub UUID that is not in the 1.4.0 denylist", async () => {
    tempHome();
    process.env.GROQ_API_KEY = "fake-test-key";
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
    const dir = mkdtempSync(join(tmpdir(), "seri-doctor-bin-"));
    dirs.push(dir);
    const execPath = join(dir, "seri");
    const olderBun = "c7e7a979-f99b-3466-9ad6-e56a63373a35";
    writeFileSync(execPath, thinMachO(olderBun, Buffer.from("older-bun")));
    const checks = await runDoctorChecks({
      grep: async () => ({
        mode: "content",
        matches: [{ file: "probe.txt", line: 1, text: "seri selftest probe" }],
        truncated: false,
      }),
      fetch: asFetch(async () => {
        throw new Error("doctor must not fetch");
      }),
      execPath,
      env: process.env,
      platform: "darwin",
      arch: "arm64",
      cwd: process.cwd(),
      probeIoUring: () => ({ status: "allow" }),
    });
    const uuid = checks.find((check) => check.name === "macho_uuid");
    expect(uuid?.status).toBe("fail");
    expect(uuid?.detail).toContain(olderBun);
    expect(uuid?.detail).toContain("not a content-derived UUID");
    if (uuid === undefined) return;
    expect(doctorExitCode([uuid])).toBe(1);
  });

  test("reports macho_uuid ok after the stub is stamped", async () => {
    tempHome();
    process.env.GROQ_API_KEY = "fake-test-key";
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
    const dir = mkdtempSync(join(tmpdir(), "seri-doctor-bin-"));
    dirs.push(dir);
    const execPath = join(dir, "seri");
    const bytes = thinMachO(BUN_COMPILE_UUID_DARWIN_ARM64, Buffer.from("stub"));
    const stamped = stampMachOUuid(bytes);
    expect(stamped.kind).toBe("rewritten");
    writeFileSync(execPath, bytes);
    const checks = await runDoctorChecks({
      grep: async () => ({
        mode: "content",
        matches: [{ file: "probe.txt", line: 1, text: "seri selftest probe" }],
        truncated: false,
      }),
      fetch: asFetch(async () => {
        throw new Error("doctor must not fetch");
      }),
      execPath,
      env: process.env,
      platform: "darwin",
      arch: "arm64",
      cwd: process.cwd(),
      probeIoUring: () => ({ status: "allow" }),
    });
    const uuid = checks.find((check) => check.name === "macho_uuid");
    expect(uuid?.status).toBe("ok");
    if (stamped.kind === "rewritten") expect(uuid?.detail).toBe(stamped.after);
    if (uuid === undefined) return;
    expect(doctorExitCode([uuid])).toBe(0);
  });
});
