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

  // The exact hijack class SLASH_COMMANDS' own comment documents: a task that happens to start
  // with "/memory" must fall through to the model, not be swallowed by this command.
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
    // A 7-char prefix of the id, not all 12: enough to type back into approve/reject, and short
    // enough that the write itself is the widest thing on the row.
    expect(pending.lines[0]?.text).toContain(staged.id.slice(0, 7));
    expect(pending.lines[0]?.text).toContain("USER.md");
    // The scope bracket is gone on purpose — "USER.md" already says which file this targets.
    expect(pending.lines[0]?.text).not.toContain("[user]");

    const diff = decideMemoryCommand(["diff", staged.id], ctx);
    expect(diff.lines.some((l) => l.text.includes("prefers tabs"))).toBe(true);

    decideMemoryCommand(["reject", staged.id], ctx);
    expect(decideMemoryCommand(["pending"], ctx).lines[0]?.text).toContain("No staged");
  });

  // Round-4 review finding: a memory-project entry's target project was invisible in both
  // /memory pending's summary line and /memory diff's header — diffPending used to print
  // basename(file.path), which for a project file is always literally "MEMORY.md" (the project
  // only appears as a hash-token directory in between, per memoryFilePath). A human reviewing
  // staged writes from two different repos could not tell a memory-project entry staged in one
  // apart from one targeting the other before approving it.
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

  // diffPending re-runs computeWrite against the CURRENT live file (correct — approve-time
  // re-check), which can throw for one entry without that throw discarding every diff already
  // collected for entries processed before/after it.
  test("diff all still shows a good entry's diff plus an inline error for a bad one", () => {
    const ctx = makeCtx();
    stagePendingWrite(
      { scope: "user", action: "add", content: "a fine entry", reason: "r", durable: true },
      ctx,
      new Date(),
    );
    stagePendingWrite(
      // Never matches anything in the (empty) live file — diffPending's own computeWrite call
      // throws "no entry contains" for this one.
      { scope: "user", action: "remove", target: "does not exist", reason: "r", durable: true },
      ctx,
      new Date(),
    );

    const result = decideMemoryCommand(["diff", "all"], ctx);
    expect(result.lines.some((l) => l.text.includes("a fine entry"))).toBe(true);
    expect(result.lines.some((l) => l.text.startsWith("Could not diff"))).toBe(true);
  });

  // rejectPending is a raw unlinkSync with no existence check -- an entry whose underlying file no
  // longer matches what listPending resolved (a concurrent process rejecting/removing it between
  // resolution and this call) must not abort the rest of "reject all" with zero output. Simulated
  // deterministically, cross-platform: a .pending file is written whose OWN "id" field names a
  // path that does not exist on disk (pendingPath is derived from the record's id, not from the
  // filename it was read from) -- rejectPending's unlinkSync then throws ENOENT for exactly this
  // record, the same failure shape a real race produces, without depending on timing.
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
    // One count for everything that worked, the ids only on the failure — the whole point of the
    // collapse. `good` is the only success here, so the count is 1.
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

  // The message the collapse exists for: a full queue used to print one "Rejected <hex>." line per
  // entry, twenty of which pushed everything else off the viewport and told the reader nothing the
  // count does not.
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
    // A replace shows both halves, which is the one action whose "what does this write say" answer
    // is not a single string.
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
