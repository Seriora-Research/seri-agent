import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  applyWrite,
  computeWrite,
  loadMemory,
  loadMemoryFile,
  MEMORY_CAPS,
  type MemoryContext,
  type MemoryFile,
  memoryFilePath,
  projectDirToken,
  renderArchivistMemory,
  renderMemoryTier,
} from "../../src/memory/store";

const originalPlatform = process.platform;
function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform });
}

let configDir: string | undefined;
function makeCtx(worktree = "C:\\proj\\harness"): MemoryContext {
  configDir = mkdtempSync(join(tmpdir(), "seri-memory-"));
  return { configDir, worktree };
}

afterEach(() => {
  setPlatform(originalPlatform);
  if (configDir !== undefined) rmSync(configDir, { recursive: true, force: true });
  configDir = undefined;
});

describe("projectDirToken", () => {
  test("is 16 lowercase hex chars, stable across calls", () => {
    const token = projectDirToken("/home/x/proj");
    expect(token).toMatch(/^[0-9a-f]{16}$/);
    expect(projectDirToken("/home/x/proj")).toBe(token);
  });

  test("differs for two different paths", () => {
    expect(projectDirToken("/home/x/proj-a")).not.toBe(projectDirToken("/home/x/proj-b"));
  });

  test("is identical for two differently-cased paths on a case-folding platform", () => {
    setPlatform("win32");
    expect(projectDirToken("C:\\X\\Proj")).toBe(projectDirToken("c:\\x\\proj"));
  });

  test("negative control: stays distinct by case on a non-folding platform", () => {
    setPlatform("linux");
    expect(projectDirToken("/home/X/Proj")).not.toBe(projectDirToken("/home/x/proj"));
  });
});

describe("memoryFilePath", () => {
  test("resolves all three scopes under getMemoriesDir", () => {
    const ctx = makeCtx();
    expect(basename(memoryFilePath("user", ctx))).toBe("USER.md");
    expect(basename(memoryFilePath("memory-global", ctx))).toBe("MEMORY.md");
    const projectPath = memoryFilePath("memory-project", ctx);
    expect(basename(projectPath)).toBe("MEMORY.md");
    expect(projectPath).toContain(projectDirToken(ctx.worktree));
  });
});

describe("loadMemoryFile / loadMemory", () => {
  test("a missing file loads as empty with no entries", () => {
    const ctx = makeCtx();
    const file = loadMemoryFile("user", ctx);
    expect(file.text).toBe("");
    expect(file.chars).toBe(0);
    expect(file.entries).toEqual([]);
    expect(file.cap).toBe(MEMORY_CAPS.user);
  });

  test("loadMemory loads all three scopes with the right project label", () => {
    const ctx = makeCtx("/home/x/harness");
    const memory = loadMemory(ctx);
    expect(memory.user.label).toBe("USER.md");
    expect(memory.global.label).toBe("MEMORY.md");

    expect(memory.project.label).toBe("harness/MEMORY.md");
    expect(memory.project.path).not.toContain("harness");
  });




  test("a file written with a trailing newline loads with the correct entry count, no phantom entry", () => {
    const ctx = makeCtx();
    const path = memoryFilePath("user", ctx);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "- [2026-08-11] one entry\n");
    const file = loadMemoryFile("user", ctx);
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0].text).toBe("one entry");
    expect(file.text).toBe("- [2026-08-11] one entry");
  });








  test("a global file with just a trailing newline still renders '(nothing recorded yet)', not a stray blank line", () => {
    const ctx = makeCtx();
    applyWrite(
      { scope: "user", action: "add", content: "real entry", reason: "r", durable: true },
      ctx,
      "2026-08-11",
    );
    const globalPath = memoryFilePath("memory-global", ctx);
    mkdirSync(dirname(globalPath), { recursive: true });
    writeFileSync(globalPath, "\n");

    const lines = renderMemoryTier(loadMemory(ctx)).split("\n");
    const headingIndex = lines.findIndex((l) => l.startsWith("## Global notes"));


    expect(lines[headingIndex + 1]).toBe("(nothing recorded yet)");
  });



  test("a CRLF file loads with LF-only text and the CRLF-inflated char count is not used", () => {
    const ctx = makeCtx();
    const path = memoryFilePath("user", ctx);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "- [2026-08-11] one\r\n- [2026-08-11] two\r\n");
    const file = loadMemoryFile("user", ctx);
    expect(file.text).toBe("- [2026-08-11] one\n- [2026-08-11] two");
    expect(file.entries).toHaveLength(2);
  });
});

describe("computeWrite: action semantics", () => {
  function emptyFile(scope: "user" | "memory-global" | "memory-project" = "user"): MemoryFile {
    return {
      scope,
      path: "/x/USER.md",
      text: "",
      chars: 0,
      cap: MEMORY_CAPS[scope],
      entries: [],
      label: "USER.md",
    };
  }

  test("add appends a dated line", () => {
    const next = computeWrite(
      emptyFile(),
      { scope: "user", action: "add", content: "prefers tabs", reason: "r", durable: true },
      "2026-08-11",
    );
    expect(next).toBe("- [2026-08-11] prefers tabs");
  });

  test("add rejects embedded newlines", () => {
    expect(() =>
      computeWrite(
        emptyFile(),
        { scope: "user", action: "add", content: "a\nb", reason: "r", durable: true },
        "2026-08-11",
      ),
    ).toThrow(/single line/);
  });

  test("replace refreshes the entry's date and keeps line count constant", () => {
    const file: MemoryFile = {
      ...emptyFile(),
      text: "- [2026-01-01] old fact\n- [2026-01-02] other fact",
      chars: 0,
      entries: [
        { date: "2026-01-01", text: "old fact", line: "- [2026-01-01] old fact" },
        { date: "2026-01-02", text: "other fact", line: "- [2026-01-02] other fact" },
      ],
    };
    const next = computeWrite(
      file,
      {
        scope: "user",
        action: "replace",
        target: "old fact",
        content: "new fact",
        reason: "r",
        durable: true,
      },
      "2026-08-11",
    );
    expect(next.split("\n")).toHaveLength(2);
    expect(next).toContain("- [2026-08-11] new fact");
    expect(next).toContain("- [2026-01-02] other fact");
  });

  test("remove deletes the whole line", () => {
    const file: MemoryFile = {
      ...emptyFile(),
      text: "- [2026-01-01] old fact\n- [2026-01-02] other fact",
      entries: [
        { date: "2026-01-01", text: "old fact", line: "- [2026-01-01] old fact" },
        { date: "2026-01-02", text: "other fact", line: "- [2026-01-02] other fact" },
      ],
    };
    const next = computeWrite(
      file,
      { scope: "user", action: "remove", target: "old fact", reason: "r", durable: true },
      "2026-08-11",
    );
    expect(next).toBe("- [2026-01-02] other fact");
  });

  test("an ambiguous target throws with the match count", () => {
    const file: MemoryFile = {
      ...emptyFile(),
      text: "- [2026-01-01] uses bun test\n- [2026-01-02] also uses bun test here",
      entries: [
        { date: "2026-01-01", text: "uses bun test", line: "- [2026-01-01] uses bun test" },
        {
          date: "2026-01-02",
          text: "also uses bun test here",
          line: "- [2026-01-02] also uses bun test here",
        },
      ],
    };
    expect(() =>
      computeWrite(
        file,
        { scope: "user", action: "remove", target: "bun test", reason: "r", durable: true },
        "2026-08-11",
      ),
    ).toThrow(/2 entries/);
  });

  test("a target matching nothing throws", () => {
    expect(() =>
      computeWrite(
        emptyFile(),
        { scope: "user", action: "remove", target: "nope", reason: "r", durable: true },
        "2026-08-11",
      ),
    ).toThrow(/no entry contains/);
  });






  test("an empty target throws rather than matching every entry", () => {
    const file: MemoryFile = {
      ...emptyFile(),
      text: "- [2026-01-01] only entry",
      entries: [{ date: "2026-01-01", text: "only entry", line: "- [2026-01-01] only entry" }],
    };
    expect(() =>
      computeWrite(
        file,
        { scope: "user", action: "remove", target: "", reason: "r", durable: true },
        "2026-08-11",
      ),
    ).toThrow(/must not be empty/);
  });

  test.each([
    ["add", { action: "add" as const }],
    ["remove", { action: "remove" as const }],
    ["replace", { action: "replace" as const }],
  ])("%s with missing required fields throws", (_name, partial) => {
    expect(() =>
      computeWrite(
        emptyFile(),
        { scope: "user", reason: "r", durable: true, ...partial },
        "2026-08-11",
      ),
    ).toThrow();
  });
});

describe("computeWrite: cap enforcement (BUILD-PLAN verify bar)", () => {
  test("user cap: an add that lands over 1375 chars throws, lists every current entry, and the file on disk stays byte-identical to a captured before that differs from the write attempt", () => {
    const ctx = makeCtx();


    const seedEntry = `- [2026-08-01] ${"x".repeat(1_320)}`;
    applyWrite(
      {
        scope: "user",
        action: "add",
        content: seedEntry.slice("- [2026-08-01] ".length),
        reason: "seed",
        durable: true,
      },
      ctx,
      "2026-08-01",
    );
    const path = memoryFilePath("user", ctx);
    const before = readFileSync(path, "utf8");
    expect(before.length).toBeLessThan(MEMORY_CAPS.user);
    expect(before).not.toContain("distinct-overflow-marker");

    expect(() =>
      applyWrite(
        {
          scope: "user",
          action: "add",
          content: `distinct-overflow-marker-${"y".repeat(80)}`,
          reason: "r",
          durable: true,
        },
        ctx,
        "2026-08-11",
      ),
    ).toThrow(/over its 1375-char cap/);

    const after = readFileSync(path, "utf8");
    expect(after).toBe(before);
  });

  test("memory-global cap: an over-cap add throws and the message names the exact overage", () => {
    const ctx = makeCtx();
    const seedContent = "x".repeat(2_180);
    applyWrite(
      {
        scope: "memory-global",
        action: "add",
        content: seedContent,
        reason: "seed",
        durable: true,
      },
      ctx,
      "2026-08-01",
    );
    const path = memoryFilePath("memory-global", ctx);
    const before = readFileSync(path, "utf8");

    let thrown: Error | undefined;
    try {
      applyWrite(
        {
          scope: "memory-global",
          action: "add",
          content: "one more fact",
          reason: "r",
          durable: true,
        },
        ctx,
        "2026-08-11",
      );
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown?.message).toContain("2200-char cap");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("memory-project cap: an over-cap add throws and the live file stays untouched", () => {
    const ctx = makeCtx("/home/x/harness");
    const seedContent = "x".repeat(2_180);
    applyWrite(
      {
        scope: "memory-project",
        action: "add",
        content: seedContent,
        reason: "seed",
        durable: true,
      },
      ctx,
      "2026-08-01",
    );
    const path = memoryFilePath("memory-project", ctx);
    const before = readFileSync(path, "utf8");

    expect(() =>
      applyWrite(
        {
          scope: "memory-project",
          action: "add",
          content: "one more fact",
          reason: "r",
          durable: true,
        },
        ctx,
        "2026-08-11",
      ),
    ).toThrow(/2200-char cap/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("applyWrite", () => {
  test("writes LF-only, never CRLF, even on win32", () => {
    setPlatform("win32");
    const ctx = makeCtx();
    applyWrite(
      { scope: "user", action: "add", content: "one", reason: "r", durable: true },
      ctx,
      "2026-08-11",
    );
    const path = memoryFilePath("user", ctx);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("\r\n");
  });

  test("returns before/after and the before differs from a distinct after", () => {
    const ctx = makeCtx();
    const first = applyWrite(
      { scope: "user", action: "add", content: "one", reason: "r", durable: true },
      ctx,
      "2026-08-11",
    );
    expect(first.before).toBe("");
    expect(first.after).toBe("- [2026-08-11] one");

    const second = applyWrite(
      { scope: "user", action: "add", content: "two", reason: "r", durable: true },
      ctx,
      "2026-08-11",
    );
    expect(second.before).toBe(first.after);
    expect(second.after).not.toBe(second.before);
  });
});

describe("renderMemoryTier", () => {
  test('an all-empty LoadedMemory renders "" (B2 guarantee)', () => {
    const ctx = makeCtx();
    expect(renderMemoryTier(loadMemory(ctx))).toBe("");
  });

  test("negative control: a non-empty file renders something", () => {
    const ctx = makeCtx();
    applyWrite(
      { scope: "user", action: "add", content: "prefers tabs", reason: "r", durable: true },
      ctx,
      "2026-08-11",
    );
    const rendered = renderMemoryTier(loadMemory(ctx));
    expect(rendered).not.toBe("");
    expect(rendered).toContain("# Memory");
    expect(rendered).toContain("prefers tabs");
    expect(rendered).toMatch(/\d+% — \d+\/1375 chars/);
    expect(rendered).toContain("You cannot edit these directly");
  });
});

describe("renderArchivistMemory", () => {
  test("empty files render empty, same as renderMemoryTier", () => {
    const ctx = makeCtx();
    expect(renderArchivistMemory(loadMemory(ctx))).toBe("");
  });

  test("keeps entries and budgets without the coding-agent intro", () => {
    const ctx = makeCtx();
    applyWrite(
      { scope: "user", action: "add", content: "prefers tabs", reason: "r", durable: true },
      ctx,
      "2026-08-11",
    );
    const rendered = renderArchivistMemory(loadMemory(ctx));
    expect(rendered).toContain("prefers tabs");
    expect(rendered).toMatch(/\d+% — \d+\/1375 chars/);
    expect(rendered).not.toContain("You cannot edit these directly");
    expect(rendered).not.toContain("frozen for this session");
    expect(rendered).not.toContain("# Memory");

    expect(renderMemoryTier(loadMemory(ctx))).toContain("You cannot edit these directly");
  });
});
