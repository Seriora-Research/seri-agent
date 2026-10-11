import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyWrite,
  type MemoryContext,
  memoryFilePath,
  scanMemorySecrets,
} from "../../src/memory/store";

const GHP = `ghp_${"A".repeat(20)}B9Qx`;
const DATE = "2026-10-11";
const CHILD_MODE = "SERI_MEMORY_CONCURRENCY_CHILD";

function ctxFor(configDir: string): MemoryContext {
  return { configDir, worktree: "/home/x/harness" };
}

const childMode = process.env[CHILD_MODE];
if (childMode === "add") {
  const [configDir, writer, count] = process.argv.slice(2);
  for (let i = 0; i < Number(count); i++) {
    applyWrite(
      {
        scope: "memory-global",
        action: "add",
        content: `w${writer}-${i}`,
        reason: "race",
        durable: true,
      },
      ctxFor(configDir),
      DATE,
    );
  }
  process.exit(0);
}
if (childMode === "scrub") {
  scanMemorySecrets(process.argv[2], true);
  process.exit(0);
}

let dirs: string[] = [];
function makeConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seri-memory-race-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function spawnChild(mode: "add" | "scrub", args: string[]) {
  return Bun.spawn([process.execPath, import.meta.path, ...args], {
    env: { ...process.env, [CHILD_MODE]: mode },
    stdout: "ignore",
    stderr: "pipe",
  });
}

async function settle(child: ReturnType<typeof spawnChild>) {
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { exitCode, stderr };
}

function addLines(writers: number, perWriter: number): string[] {
  return Array.from({ length: writers }, (_, w) =>
    Array.from({ length: perWriter }, (_, i) => `- [${DATE}] w${w}-${i}`),
  ).flat();
}

function globalLines(configDir: string): string[] {
  return readFileSync(memoryFilePath("memory-global", ctxFor(configDir)), "utf8").split("\n");
}

describe("memory writes from several seri processes", () => {
  test("six processes adding fifteen entries each keep all ninety", async () => {
    const configDir = makeConfigDir();
    const children = Array.from({ length: 6 }, (_, w) =>
      spawnChild("add", [configDir, String(w), "15"]),
    );

    expect(await Promise.all(children.map(settle))).toEqual(
      children.map(() => ({ exitCode: 0, stderr: "" })),
    );
    expect(globalLines(configDir).sort()).toEqual(addLines(6, 15).sort());
  }, 15000);

  test.skipIf(process.platform === "win32")(
    "adds that land while a scrub is reading the file survive the scrub, and the seeded token is redacted",
    async () => {
      const configDir = makeConfigDir();
      const path = memoryFilePath("memory-global", ctxFor(configDir));
      mkdirSync(dirname(path), { recursive: true });
      expect(spawnSync("mkfifo", [path]).status).toBe(0);
      const seed = `- [${DATE}] deploy with ${GHP}`;

      const scrub = spawnChild("scrub", [configDir]);
      const feed = await open(path, "w");
      writeFileSync(`${path}.seed`, seed);
      renameSync(`${path}.seed`, path);
      const adds = Array.from({ length: 3 }, (_, w) =>
        spawnChild("add", [configDir, String(w), "15"]),
      );
      await Promise.race([Promise.all(adds.map((child) => child.exited)), Bun.sleep(500)]);
      await feed.write(seed);
      await feed.close();

      expect(await Promise.all([scrub, ...adds].map(settle))).toEqual(
        [scrub, ...adds].map(() => ({ exitCode: 0, stderr: "" })),
      );
      expect(globalLines(configDir).sort()).toEqual(
        [`- [${DATE}] deploy with [redacted:github-pat:B9Qx]`, ...addLines(3, 15)].sort(),
      );
    },
    15000,
  );
});
