import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadMemoryConfig } from "../../src/config/config";
import {
  decideMemoryCommand,
  memoryCommandAccepts,
  memoryDiffLines,
  memoryPanelRows,
} from "../../src/memory/commands";
import { pendingPath, stagePendingWrite } from "../../src/memory/pending";
import type { MemoryContext } from "../../src/memory/store";

let configDir: string | undefined;
function makeCtx(worktree = "/home/x/harness"): MemoryContext {
  configDir = mkdtempSync(join(tmpdir(), "seri-memory-"));
  return { configDir, worktree };
}

afterEach(() => {
  if (configDir !== undefined) rmSync(configDir, { recursive: true, force: true });
  configDir = undefined;
});

describe("memoryCommandAccepts", () => {
  test("accepts the exact command forms", () => {
    expect(memoryCommandAccepts([])).toBe(true);
    expect(memoryCommandAccepts(["list"])).toBe(true);
    expect(memoryCommandAccepts(["pending"])).toBe(true);
    expect(memoryCommandAccepts(["diff", "abcd1234"])).toBe(true);
    expect(memoryCommandAccepts(["diff", "all"])).toBe(true);
    expect(memoryCommandAccepts(["approve", "all"])).toBe(true);
    expect(memoryCommandAccepts(["approve", "abcd"])).toBe(true);
    expect(memoryCommandAccepts(["reject", "all"])).toBe(true);
    expect(memoryCommandAccepts(["approval", "on"])).toBe(true);
    expect(memoryCommandAccepts(["approval", "off"])).toBe(true);
    expect(memoryCommandAccepts(["archivist", "on"])).toBe(true);
    expect(memoryCommandAccepts(["archivist", "off"])).toBe(true);
  });



  test("does not accept a task that merely starts with /memory", () => {
    expect(memoryCommandAccepts(["is", "broken,", "fix", "it"])).toBe(false);
  });

  test("rejects malformed subcommand args", () => {
    expect(memoryCommandAccepts(["diff"])).toBe(false);
    expect(memoryCommandAccepts(["diff", "not-hex"])).toBe(false);
    expect(memoryCommandAccepts(["approval", "maybe"])).toBe(false);
    expect(memoryCommandAccepts(["archivist"])).toBe(false);
    expect(memoryCommandAccepts(["list", "extra"])).toBe(false);
  });
});

describe("decideMemoryCommand", () => {
  test("pending: reports none when nothing is staged", () => {
    const ctx = makeCtx();
    const result = decideMemoryCommand(["pending"], ctx);
    expect(result.lines[0]?.text).toContain("No staged");
    expect(result.lines[0]?.muted).toBe(true);
  });

  test("pending/diff/approve/reject: full staged-write lifecycle", () => {
    const ctx = makeCtx();
    const staged = stagePendingWrite(
      { scope: "user", action: "add", content: "prefers tabs", reason: "r", durable: true },
      ctx,
      new Date(),
    );

    const pending = decideMemoryCommand(["pending"], ctx);


    expect(pending.lines[0]?.text).toContain(staged.id.slice(0, 7));
    expect(pending.lines[0]?.text).toContain("USER.md");

    expect(pending.lines[0]?.text).not.toContain("[user]");

    const diff = decideMemoryCommand(["diff", staged.id], ctx);
    expect(diff.lines.some((l) => l.text.includes("prefers tabs"))).toBe(true);

    decideMemoryCommand(["reject", staged.id], ctx);
    expect(decideMemoryCommand(["pending"], ctx).lines[0]?.text).toContain("No staged");
  });







  test("pending/diff show which project a memory-project entry targets, not just MEMORY.md", () => {
    const ctx = makeCtx("/home/x/other-repo");
    const staged = stagePendingWrite(
      {
        scope: "memory-project",
        action: "add",
        content: "uses pnpm here",
        reason: "r",
        durable: true,
      },
      ctx,
      new Date(),
    );

    const pending = decideMemoryCommand(["pending"], ctx);
    expect(pending.lines[0]?.text).toContain("other-repo/MEMORY.md");
    expect(memoryPanelRows(ctx)[0]?.file).toBe("other-repo/MEMORY.md");

    const diff = decideMemoryCommand(["diff", staged.id], ctx);
    expect(diff.lines.some((l) => l.text.includes("other-repo/MEMORY.md"))).toBe(true);

    decideMemoryCommand(["approve", staged.id], ctx);
    expect(memoryPanelRows(ctx)).toHaveLength(0);
  });

  test("approve: applies the write and reports success", () => {
    const ctx = makeCtx();
    const staged = stagePendingWrite(
      { scope: "user", action: "add", content: "prefers tabs", reason: "r", durable: true },
      ctx,
      new Date(),
    );
    const result = decideMemoryCommand(["approve", staged.id], ctx);
    expect(result.lines).toEqual([{ text: "1 memory approved." }]);
  });

  test("diff/approve/reject on an unknown id report no match", () => {
    const ctx = makeCtx();
    for (const sub of ["diff", "approve", "reject"]) {
      const result = decideMemoryCommand([sub, "deadbeef"], ctx);
      expect(result.lines[0]?.text).toContain("No staged write matches");
    }
  });

  test("approval on|off toggles SERI_MEMORY_APPROVAL and loadMemoryConfig reflects it", () => {
    const ctx = makeCtx();
    decideMemoryCommand(["approval", "off"], ctx);
    expect(loadMemoryConfig(ctx.configDir).approvalRequired).toBe(false);

    decideMemoryCommand(["approval", "on"], ctx);
    expect(loadMemoryConfig(ctx.configDir).approvalRequired).toBe(true);
  });

  test("an unknown approval arg returns a usage line", () => {
    const ctx = makeCtx();
    const result = decideMemoryCommand(["approval"], ctx);
    expect(result.lines[0]?.text).toContain("Usage:");
    expect(result.lines[0]?.muted).toBe(true);
  });

  test("archivist on|off toggles SERI_ARCHIVIST_ENABLED and loadMemoryConfig reflects it", () => {
    const ctx = makeCtx();
    decideMemoryCommand(["archivist", "off"], ctx);
    expect(loadMemoryConfig(ctx.configDir).archivistEnabled).toBe(false);

    decideMemoryCommand(["archivist", "on"], ctx);
    expect(loadMemoryConfig(ctx.configDir).archivistEnabled).toBe(true);
  });

  test("archivist with no arg or an invalid arg returns a usage line", () => {
    const ctx = makeCtx();
    expect(decideMemoryCommand(["archivist"], ctx)).toEqual({
      lines: [
        {
          text: "Usage: /memory | pending | diff <id|all> | approve <id|all> | reject <id|all> | approval on|off | archivist on|off",
          muted: true,
        },
      ],
    });
    expect(decideMemoryCommand(["archivist", "maybe"], ctx).lines[0]?.text).toContain("Usage:");
  });




  test("diff all still shows a good entry's diff plus an inline error for a bad one", () => {
    const ctx = makeCtx();
    stagePendingWrite(
      { scope: "user", action: "add", content: "a fine entry", reason: "r", durable: true },
      ctx,
      new Date(),
    );
    stagePendingWrite(


      { scope: "user", action: "remove", target: "does not exist", reason: "r", durable: true },
      ctx,
      new Date(),
    );

    const result = decideMemoryCommand(["diff", "all"], ctx);
    expect(result.lines.some((l) => l.text.includes("a fine entry"))).toBe(true);
    expect(result.lines.some((l) => l.text.startsWith("Could not diff"))).toBe(true);
  });








  test("reject all still rejects a good entry and reports an inline error for one whose own id resolves to a missing file", () => {
    const ctx = makeCtx();
    const good = stagePendingWrite(
      { scope: "user", action: "add", content: "a fine entry", reason: "r", durable: true },
      ctx,
      new Date(),
    );
    const staleId = "bbbbbbbbbbbb";
    const onDiskPath = pendingPath(ctx.configDir, "user", "aaaaaaaaaaaa");
    mkdirSync(dirname(onDiskPath), { recursive: true });
    writeFileSync(
      onDiskPath,
      JSON.stringify({
        id: staleId,
        stagedAt: new Date().toISOString(),
        scope: "user",
        action: "add",
        content: "x",
        reason: "r",
        durable: true,
        entryDate: "2026-08-11",
      }),
    );

    const result = decideMemoryCommand(["reject", "all"], ctx);


    expect(result.lines[0]).toEqual({ text: "1 memory rejected." });
    expect(result.lines.some((l) => l.text.startsWith(`Could not reject ${staleId}`))).toBe(true);
    expect(good.id).not.toBe(staleId);
  });

  test("approve all applies writes staged in all three scopes", () => {
    const ctx = makeCtx("/home/x/harness");
    stagePendingWrite(
      { scope: "user", action: "add", content: "u", reason: "r", durable: true },
      ctx,
      new Date(),
    );
    stagePendingWrite(
      { scope: "memory-global", action: "add", content: "g", reason: "r", durable: true },
      ctx,
      new Date(),
    );
    stagePendingWrite(
      { scope: "memory-project", action: "add", content: "p", reason: "r", durable: true },
      ctx,
      new Date(),
    );

    const result = decideMemoryCommand(["approve", "all"], ctx);
    expect(result.lines).toEqual([{ text: "3 memories approved." }]);
    expect(decideMemoryCommand(["pending"], ctx).lines[0]?.text).toContain("No staged");
  });




  test("reject all reports one count, not one line per entry", () => {
    const ctx = makeCtx();
    for (const content of ["a", "b", "c", "d"]) {
      stagePendingWrite(
        { scope: "user", action: "add", content, reason: "r", durable: true },
        ctx,
        new Date(),
      );
    }

    expect(decideMemoryCommand(["reject", "all"], ctx).lines).toEqual([
      { text: "4 memories rejected." },
    ]);
    expect(memoryPanelRows(ctx)).toHaveLength(0);
  });

  test("the listing ends in a muted hint, and the rows themselves are not muted", () => {
    const ctx = makeCtx();
    stagePendingWrite(
      { scope: "user", action: "add", content: "prefers tabs", reason: "r", durable: true },
      ctx,
      new Date(),
    );

    const { lines } = decideMemoryCommand(["pending"], ctx);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.muted).toBeUndefined();
    expect(lines[1]?.muted).toBe(true);
    expect(lines[1]?.text).toContain("/memory diff <id>");
  });
});

describe("memoryPanelRows", () => {
  test("carries what the panel renders, ordered oldest first", () => {
    const ctx = makeCtx("/home/x/harness");
    stagePendingWrite(
      { scope: "user", action: "add", content: "prefers tabs", reason: "said so", durable: true },
      ctx,
      new Date("2026-08-01T00:00:00Z"),
    );
    stagePendingWrite(
      {
        scope: "memory-project",
        action: "replace",
        target: "old",
        content: "new",
        reason: "moved",
        durable: false,
      },
      ctx,
      new Date("2026-08-02T00:00:00Z"),
    );

    const rows = memoryPanelRows(ctx);
    expect(rows.map((r) => r.action)).toEqual(["add", "replace"]);
    expect(rows[0]).toMatchObject({
      action: "add",
      file: "USER.md",
      detail: "prefers tabs",
      reason: "said so",
      durable: true,
    });


    expect(rows[1]?.detail).toBe("old → new");
    expect(rows[1]?.durable).toBe(false);
    expect(rows[1]?.file).toBe("harness/MEMORY.md");
  });
});

describe("memoryDiffLines", () => {
  test("renders one staged write's diff by id, and reports a miss as a line", () => {
    const ctx = makeCtx();
    const staged = stagePendingWrite(
      { scope: "user", action: "add", content: "prefers tabs", reason: "r", durable: true },
      ctx,
      new Date(),
    );

    expect(memoryDiffLines(ctx, staged.id).some((l) => l.includes("prefers tabs"))).toBe(true);
    expect(memoryDiffLines(ctx, "deadbeef")[0]).toContain("No staged write matches");
  });
});
