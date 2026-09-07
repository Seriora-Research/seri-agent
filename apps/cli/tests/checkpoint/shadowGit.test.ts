import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { gitArgv } from "../../src/checkpoint/gitArgv";
import {
  applyRestore,
  commitTree,
  deleteRef,
  diffTree,
  initShadow,
  isGitAvailable,
  isIgnored,
  listSessionRefs,
  mirrorLocalExcludes,
  planRestore,
  projectRoot,
  updateRef,
  writeTree,
} from "../../src/checkpoint/shadowGit";

// Cold first snapshot measured 300 ms on Windows; bun's default timeout is too tight on a loaded runner.
const GIT_TEST_TIMEOUT_MS = 30_000;

let root: string;
let gitDir: string;
let workTree: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "seri-shadowgit-test-"));
  gitDir = join(root, "git");
  workTree = join(root, "work");
  mkdirSync(workTree, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedWorktree(dir: string): void {
  writeFileSync(join(dir, ".gitignore"), "*.log\nnode_modules/\n");
  writeFileSync(join(dir, "lf.txt"), "line1\nline2\n");
  writeFileSync(join(dir, "crlf.txt"), "line1\r\nline2\r\n");
  writeFileSync(join(dir, "bin.dat"), Buffer.from([0x00, 0xff, 0x01, 0x00, 0xfe, 0x7f]));
  writeFileSync(join(dir, "no-newline.txt"), "no trailing newline");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "sub", "nested.txt"), "nested\nlines\n");
}

function manifest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        walk(path);
      } else {
        out[relative(dir, path).replaceAll("\\", "/")] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
      }
    }
  };
  walk(dir);
  return out;
}

function restore(tree: string): { restored: string[]; deleted: string[] } {
  const plan = planRestore(gitDir, workTree, tree);
  applyRestore(gitDir, workTree, plan.deleted);
  return plan;
}

function snapshot(parent?: string): { tree: string; commit: string } {
  const tree = writeTree(gitDir, workTree);
  return { tree, commit: commitTree(gitDir, workTree, tree, parent) };
}

function treeNames(tree: string): string {
  const result = spawnSync("git", [`--git-dir=${gitDir}`, "ls-tree", "-r", "--name-only", tree], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout;
}

describe.skipIf(!isGitAvailable())("shadowGit", () => {
  test(
    "restores byte-identical content after five mutating checkpoints",
    () => {
      seedWorktree(workTree);
      initShadow(gitDir);
      const before = manifest(workTree);
      const first = snapshot();

      let parent = first.commit;
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(workTree, "lf.txt"), `mutation ${i}\n`);
        writeFileSync(join(workTree, "crlf.txt"), `mutation ${i}\r\n`);
        writeFileSync(join(workTree, "sub", "nested.txt"), `mutation ${i}\n`);
        parent = snapshot(parent).commit;
      }

      restore(first.tree);

      expect(manifest(workTree)).toEqual(before);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "restores byte-identical content despite a worktree .gitattributes forcing CRLF",
    () => {
      seedWorktree(workTree);
      writeFileSync(join(workTree, ".gitattributes"), "* text eol=crlf\n");
      initShadow(gitDir);
      const before = manifest(workTree);
      const first = snapshot();

      writeFileSync(join(workTree, "lf.txt"), "mutated\n");
      writeFileSync(join(workTree, "sub", "nested.txt"), "mutated\n");
      snapshot(first.commit);

      restore(first.tree);

      expect(manifest(workTree)).toEqual(before);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "really deletes a non-ASCII path rather than reporting a deletion that did not happen",
    () => {
      // Cyrillic has no Unicode decomposition, so macOS core.precomposeunicode cannot make this flaky.
      const name = "тест-файл.txt";
      seedWorktree(workTree);
      initShadow(gitDir);
      const first = snapshot();

      writeFileSync(join(workTree, name), "created after the snapshot\n");

      const { deleted } = restore(first.tree);

      expect(deleted).toEqual([name]);
      expect(existsSync(join(workTree, name))).toBe(false);
      expect(readFileSync(join(workTree, "lf.txt"), "utf8")).toBe("line1\nline2\n");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "restores a tracked non-ASCII path byte-identically",
    () => {
      const name = "тест-файл.txt";
      seedWorktree(workTree);
      writeFileSync(join(workTree, name), "original\n");
      initShadow(gitDir);
      const before = manifest(workTree);
      const first = snapshot();

      writeFileSync(join(workTree, name), "mutated\n");
      snapshot(first.commit);

      const { restored } = restore(first.tree);

      expect(restored).toEqual([name]);
      expect(manifest(workTree)).toEqual(before);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "deletes files created after the snapshot, recreates a deleted one, and leaves the empty directory",
    () => {
      seedWorktree(workTree);
      initShadow(gitDir);
      const first = snapshot();

      writeFileSync(join(workTree, "newfile.txt"), "new\n");
      mkdirSync(join(workTree, "newdir"), { recursive: true });
      writeFileSync(join(workTree, "newdir", "deep.txt"), "deep\n");
      rmSync(join(workTree, "sub", "nested.txt"));

      const { restored, deleted } = restore(first.tree);

      expect(existsSync(join(workTree, "newfile.txt"))).toBe(false);
      expect(existsSync(join(workTree, "newdir", "deep.txt"))).toBe(false);
      expect(readFileSync(join(workTree, "sub", "nested.txt"), "utf8")).toBe("nested\nlines\n");
      expect([...deleted].sort()).toEqual(["newdir/deep.txt", "newfile.txt"]);
      expect(restored).toEqual(["sub/nested.txt"]);

      expect(existsSync(join(workTree, "newdir"))).toBe(true);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "leaves gitignored files alone and never reports them as restored or deleted",
    () => {
      seedWorktree(workTree);
      mkdirSync(join(workTree, "node_modules"), { recursive: true });
      writeFileSync(join(workTree, "secret.log"), "original secret\n");
      writeFileSync(join(workTree, "node_modules", "dep.js"), "original dep\n");
      initShadow(gitDir);
      const first = snapshot();

      writeFileSync(join(workTree, "secret.log"), "mutated secret\n");
      writeFileSync(join(workTree, "node_modules", "dep.js"), "mutated dep\n");
      writeFileSync(join(workTree, "lf.txt"), "mutated\n");

      const { restored, deleted } = restore(first.tree);

      expect(readFileSync(join(workTree, "secret.log"), "utf8")).toBe("mutated secret\n");
      expect(readFileSync(join(workTree, "node_modules", "dep.js"), "utf8")).toBe("mutated dep\n");
      expect([...restored, ...deleted]).toEqual(["lf.txt"]);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "path-scoped writeTree restages one file and leaves a sibling untracked",
    () => {
      seedWorktree(workTree);
      initShadow(gitDir);
      const first = writeTree(gitDir, workTree);

      writeFileSync(join(workTree, "lf.txt"), "mutated\n");
      writeFileSync(join(workTree, "sneaky.txt"), "unrelated\n");
      const scoped = writeTree(gitDir, workTree, ["lf.txt"]);

      expect(scoped).not.toBe(first);
      expect(treeNames(scoped)).toContain("lf.txt");
      expect(treeNames(scoped)).not.toContain("sneaky.txt");

      const full = writeTree(gitDir, workTree);
      expect(treeNames(full)).toContain("sneaky.txt");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "path-scoped writeTree skips a missing path rather than failing",
    () => {
      seedWorktree(workTree);
      initShadow(gitDir);
      const first = writeTree(gitDir, workTree);

      expect(writeTree(gitDir, workTree, ["does-not-exist.txt"])).toBe(first);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test("isIgnored answers from the worktree's own .gitignore", () => {
    seedWorktree(workTree);
    initShadow(gitDir);

    expect(isIgnored(gitDir, workTree, "secret.log")).toBe(true);
    expect(isIgnored(gitDir, workTree, "node_modules/dep.js")).toBe(true);
    expect(isIgnored(gitDir, workTree, "lf.txt")).toBe(false);
  });

  test("diffTree reports the pending change against a snapshot", () => {
    seedWorktree(workTree);
    initShadow(gitDir);
    const first = snapshot();
    writeFileSync(join(workTree, "lf.txt"), "mutated\n");
    writeTree(gitDir, workTree);

    const diff = diffTree(gitDir, workTree, first.tree);

    expect(diff).toContain("lf.txt");
    expect(diff).toContain("+mutated");
  });

  test(
    "leaves a worktree that is itself a git repo completely unpolluted",
    () => {
      seedWorktree(workTree);
      const userGit = (args: string[]): string => {
        const result = spawnSync("git", args, {
          encoding: "utf8",
          cwd: workTree,
          windowsHide: true,
        });
        expect(result.status).toBe(0);
        return result.stdout;
      };
      userGit(["init", "-q"]);
      userGit(["-c", "user.name=u", "-c", "user.email=u@e", "add", "-A"]);
      userGit([
        "-c",
        "user.name=u",
        "-c",
        "user.email=u@e",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "initial",
      ]);

      const captured = [
        userGit(["status", "--porcelain"]),
        userGit(["reflog", "--all"]),
        userGit(["for-each-ref"]),
      ];

      initShadow(gitDir);
      const first = snapshot();
      writeFileSync(join(workTree, "lf.txt"), "mutated\n");
      writeFileSync(join(workTree, "newfile.txt"), "new\n");
      snapshot(first.commit);
      restore(first.tree);

      expect([
        userGit(["status", "--porcelain"]),
        userGit(["reflog", "--all"]),
        userGit(["for-each-ref"]),
      ]).toEqual(captured);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "checkpoints a worktree that is not a git repo without creating a .git in it",
    () => {
      seedWorktree(workTree);
      initShadow(gitDir);
      const first = snapshot();
      writeFileSync(join(workTree, "lf.txt"), "mutated\n");

      restore(first.tree);

      expect(readFileSync(join(workTree, "lf.txt"), "utf8")).toBe("line1\nline2\n");
      expect(existsSync(join(workTree, ".git"))).toBe(false);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "scrubs an inherited GIT_INDEX_FILE instead of staging into it",
    () => {
      const sentinel = join(root, "sentinel-index");
      const originalIndexFile = process.env.GIT_INDEX_FILE;
      const originalGitDir = process.env.GIT_DIR;
      seedWorktree(workTree);
      initShadow(gitDir);

      try {
        process.env.GIT_INDEX_FILE = sentinel;
        process.env.GIT_DIR = join(root, "sentinel-gitdir");
        snapshot();
      } finally {
        // Reassigning a captured `undefined` sets process.env to the literal string "undefined" in Node/Bun.
        if (originalIndexFile === undefined) delete process.env.GIT_INDEX_FILE;
        else process.env.GIT_INDEX_FILE = originalIndexFile;
        if (originalGitDir === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = originalGitDir;
      }

      expect(existsSync(sentinel)).toBe(false);
      expect(existsSync(join(root, "sentinel-gitdir"))).toBe(false);
      expect(existsSync(join(gitDir, "index"))).toBe(true);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "session refs list oldest-first and survive deletion of their siblings",
    () => {
      seedWorktree(workTree);
      initShadow(gitDir);
      const first = snapshot();
      updateRef(gitDir, "refs/seri/sessions/a", first.commit);
      writeFileSync(join(workTree, "lf.txt"), "second\n");
      const second = snapshot(first.commit);
      updateRef(gitDir, "refs/seri/sessions/b", second.commit);

      expect(listSessionRefs(gitDir)).toEqual(["refs/seri/sessions/a", "refs/seri/sessions/b"]);

      deleteRef(gitDir, "refs/seri/sessions/a");
      expect(listSessionRefs(gitDir)).toEqual(["refs/seri/sessions/b"]);

      restore(first.tree);
      expect(readFileSync(join(workTree, "lf.txt"), "utf8")).toBe("line1\nline2\n");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "does not execute a repo-local core.fsmonitor helper",
    () => {
      const repo = join(root, "handed-over");
      mkdirSync(repo);
      writeFileSync(join(repo, "a.txt"), "hello\n");
      const fired = join(root, "fsmonitor-fired");
      const script = join(root, "fsmonitor-canary.cjs");
      writeFileSync(
        script,
        `"use strict";\nrequire("fs").writeFileSync(${JSON.stringify(fired)}, "fired");\n`,
      );
      const canary = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
      spawnSync("git", ["init", "-q"], { cwd: repo, windowsHide: true });
      spawnSync("git", ["config", "core.fsmonitor", canary], { cwd: repo, windowsHide: true });

      const unsanitized = spawnSync("git", ["status", "--porcelain"], {
        cwd: repo,
        encoding: "utf8",
        windowsHide: true,
      });
      expect(unsanitized.status, unsanitized.stderr).toBe(0);
      expect(existsSync(fired)).toBe(true);
      rmSync(fired, { force: true });

      spawnSync("git", gitArgv(["status", "--porcelain"]), {
        cwd: repo,
        encoding: "utf8",
        windowsHide: true,
      });
      expect(existsSync(fired)).toBe(false);

      expect(basename(projectRoot(repo))).toBe("handed-over");
      expect(existsSync(fired)).toBe(false);

      spawnSync("git", gitArgv(["rev-parse", "HEAD"]), {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      expect(existsSync(fired)).toBe(false);

      initShadow(gitDir);
      mirrorLocalExcludes(gitDir, repo);
      writeTree(gitDir, repo);
      expect(existsSync(fired)).toBe(false);

      const globalConfig = join(root, "global.gitconfig");
      spawnSync("git", ["config", "-f", globalConfig, "core.fsmonitor", canary], {
        windowsHide: true,
      });
      const originalGlobal = process.env.GIT_CONFIG_GLOBAL;
      const originalNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
      try {
        process.env.GIT_CONFIG_GLOBAL = globalConfig;
        process.env.GIT_CONFIG_NOSYSTEM = "1";
        seedWorktree(workTree);
        writeTree(gitDir, workTree);
        expect(existsSync(fired)).toBe(false);
      } finally {
        if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = originalGlobal;
        if (originalNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
        else process.env.GIT_CONFIG_NOSYSTEM = originalNoSystem;
      }
    },
    GIT_TEST_TIMEOUT_MS,
  );
});
