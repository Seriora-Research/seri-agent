import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../../src/config/paths";
import {
  buildRunManifest,
  collectContextFiles,
  hashContextFile,
  harnessId,
} from "../../src/trajectory/manifest";

const originalHome = process.env.HOME;
const originalCommit = process.env.SERI_BUILD_COMMIT;
const originalTemp = process.env.SERI_TEMPERATURE;
const originalSeed = process.env.SERI_SEED;

function restore(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

let tmpRoot: string;
let cwd: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "seri-manifest-"));
  process.env.HOME = tmpRoot;
  delete process.env.SERI_BUILD_COMMIT;
  delete process.env.SERI_TEMPERATURE;
  delete process.env.SERI_SEED;
  mkdirSync(getConfigDir(), { recursive: true });
  cwd = mkdtempSync(join(tmpRoot, "proj-"));
});

afterEach(() => {
  restore("HOME", originalHome);
  restore("SERI_BUILD_COMMIT", originalCommit);
  restore("SERI_TEMPERATURE", originalTemp);
  restore("SERI_SEED", originalSeed);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("harnessId", () => {
  test("prefers SERI_BUILD_COMMIT over git", () => {
    expect(harnessId({ SERI_BUILD_COMMIT: "abc123" }, () => "deadbeef".repeat(5))).toEqual({
      version: expect.any(String),
      commit: "abc123",
    });
  });

  test("omits commit when neither env nor git is available", () => {
    expect(harnessId({}, () => undefined)).toEqual({ version: expect.any(String) });
  });
});

describe("context hashes", () => {
  test("a changed AGENTS.md changes the hash — untouched file is the negative control", () => {
    const agents = join(cwd, "AGENTS.md");
    writeFileSync(agents, "v1");
    const first = hashContextFile(agents, cwd);
    writeFileSync(agents, "v2");
    const second = hashContextFile(agents, cwd);
    expect(first?.sha256).not.toBe(second?.sha256);
    expect(first?.path).toBe("AGENTS.md");
    writeFileSync(agents, "v1");
    expect(hashContextFile(agents, cwd)?.sha256).toBe(first?.sha256);
  });

  test("collectContextFiles includes AGENTS.md, rules, and skills", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "hi");
    const files = collectContextFiles({
      cwd,
      rules: [{ filePath: join(cwd, "rule.mdc") }],
      skills: [{ filePath: join(cwd, "SKILL.md") }],
    });
    expect(files).toContain(join(cwd, "AGENTS.md"));
    expect(files).toContain(join(cwd, "rule.mdc"));
    expect(files).toContain(join(cwd, "SKILL.md"));
  });

  test("missing files are skipped, not thrown", () => {
    expect(hashContextFile(join(cwd, "nope.md"), cwd)).toBeUndefined();
  });
});

describe("buildRunManifest", () => {
  test("records unset sampling as null on a seed-capable route", () => {
    const manifest = buildRunManifest({
      cwd,
      configDir: getConfigDir(),
      provider: "groq",
      credential: "key",
      maxIterations: 12,
      gitHead: () => undefined,
    });
    expect(manifest.temperature).toBeNull();
    expect(manifest.seed).toBeNull();
    expect(manifest.maxIterations).toBe(12);
    expect(manifest.upstreamProvider).toBeNull();
  });

  test("records seed unsupported on Anthropic even when SERI_SEED is set", () => {
    process.env.SERI_SEED = "7";
    const manifest = buildRunManifest({
      cwd,
      configDir: getConfigDir(),
      provider: "anthropic",
      credential: "key",
      maxIterations: 500,
      gitHead: () => undefined,
    });
    expect(manifest.seed).toBe("unsupported");
  });
});
