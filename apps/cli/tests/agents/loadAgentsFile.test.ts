import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAgentsFile, loadAgentsFile } from "../../src/agents/loadAgentsFile";
import { isGitAvailable } from "../../src/checkpoint/shadowGit";

// Cold git init on Windows exceeded bun's default timeout on a loaded runner (shadowGit.test.ts).
const GIT_TEST_TIMEOUT_MS = 30_000;

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

let home: string;

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const result = spawnSync("git", ["init", "-q"], { cwd: dir, windowsHide: true });
  expect(result.status).toBe(0);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "seri-loadAgentsFile-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  restoreEnv("HOME", originalHome);
  restoreEnv("USERPROFILE", originalUserProfile);
  rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!isGitAvailable())("findAgentsFile", () => {
  test(
    "loads repo-local AGENTS.md from the git root",
    () => {
      const repo = join(home, "repo");
      initRepo(repo);
      const local = join(repo, "AGENTS.md");
      writeFileSync(local, "repo local");

      expect(findAgentsFile(repo)).toBe(local);
      expect(findAgentsFile(join(repo, "nested"))).toBe(local);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "loads ~/.seri/AGENTS.md when the repo has none",
    () => {
      const repo = join(home, "repo");
      initRepo(repo);
      mkdirSync(join(repo, "nested"));
      const global = join(home, ".seri", "AGENTS.md");
      mkdirSync(join(home, ".seri"));
      writeFileSync(global, "global only");

      expect(findAgentsFile(repo)).toBe(global);
      expect(findAgentsFile(join(repo, "nested"))).toBe(global);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "repo-local AGENTS.md wins over ~/.seri/AGENTS.md",
    () => {
      const repo = join(home, "repo");
      initRepo(repo);
      const local = join(repo, "AGENTS.md");
      writeFileSync(local, "repo local");
      mkdirSync(join(home, ".seri"));
      writeFileSync(join(home, ".seri", "AGENTS.md"), "global");

      expect(findAgentsFile(repo)).toBe(local);
      expect(loadAgentsFile(repo)).toBe("repo local");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "returns undefined when neither repo-local nor ~/.seri/AGENTS.md exists",
    () => {
      const repo = join(home, "repo");
      initRepo(repo);
      mkdirSync(join(repo, "nested"));

      expect(findAgentsFile(repo)).toBeUndefined();
      expect(findAgentsFile(join(repo, "nested"))).toBeUndefined();
      expect(loadAgentsFile(repo)).toBe("");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "does not load AGENTS.md from $HOME outside ~/.seri",
    () => {
      const repo = join(home, "repo");
      initRepo(repo);
      writeFileSync(join(home, "AGENTS.md"), "home agents");
      mkdirSync(join(repo, "nested"));

      expect(findAgentsFile(repo)).toBeUndefined();
      expect(findAgentsFile(join(repo, "nested"))).toBeUndefined();
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "loads the nearest AGENTS.md between startDir and the git root",
    () => {
      const repo = join(home, "repo");
      initRepo(repo);
      writeFileSync(join(repo, "AGENTS.md"), "git root");
      const nested = join(repo, "nested");
      mkdirSync(nested);
      const nestedAgents = join(nested, "AGENTS.md");
      writeFileSync(nestedAgents, "nested");

      expect(findAgentsFile(nested)).toBe(nestedAgents);
      expect(findAgentsFile(repo)).toBe(join(repo, "AGENTS.md"));
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "loads a nested AGENTS.md when the git root has none",
    () => {
      const repo = join(home, "repo");
      initRepo(repo);
      const nested = join(repo, "nested");
      mkdirSync(nested);
      const nestedAgents = join(nested, "AGENTS.md");
      writeFileSync(nestedAgents, "nested only");

      expect(findAgentsFile(nested)).toBe(nestedAgents);
      expect(findAgentsFile(repo)).toBeUndefined();
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe("findAgentsFile without a git repo", () => {
  test("treats startDir as local when it is not inside a git repo", () => {
    const project = join(home, "loose");
    mkdirSync(project);
    const local = join(project, "AGENTS.md");
    writeFileSync(local, "cwd local");
    writeFileSync(join(home, "AGENTS.md"), "home agents");

    expect(findAgentsFile(project)).toBe(local);
  });

  test("does not walk to a parent AGENTS.md when startDir is not a git repo", () => {
    const project = join(home, "loose");
    mkdirSync(project);
    writeFileSync(join(home, "AGENTS.md"), "parent");

    expect(findAgentsFile(project)).toBeUndefined();
  });

  test("falls back to ~/.seri/AGENTS.md when startDir has none", () => {
    const project = join(home, "loose");
    mkdirSync(project);
    const global = join(home, ".seri", "AGENTS.md");
    mkdirSync(join(home, ".seri"));
    writeFileSync(global, "global only");
    writeFileSync(join(home, "AGENTS.md"), "home agents");

    expect(findAgentsFile(project)).toBe(global);
  });
});

describe("loadAgentsFile", () => {
  test("returns the file's content when found", () => {
    const project = join(home, "loose");
    mkdirSync(project);
    writeFileSync(join(project, "AGENTS.md"), "hello agents");

    expect(loadAgentsFile(project)).toBe("hello agents");
  });

  test('returns "" when none exists', () => {
    const project = join(home, "loose");
    mkdirSync(project);

    expect(loadAgentsFile(project)).toBe("");
  });
});
