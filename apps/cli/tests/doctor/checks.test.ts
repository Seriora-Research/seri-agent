import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { inspectConfig } from "../../src/config/config";
import { getConfigDir, setProfileOverride } from "../../src/config/paths";
import { runDoctorChecks } from "../../src/doctor/checks";
import { doctorExitCode, formatDoctorReport } from "../../src/doctor/report";

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
});
