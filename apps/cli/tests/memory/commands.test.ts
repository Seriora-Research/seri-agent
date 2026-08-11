import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemoryConfig } from "../../src/config/config";
import { decideMemoryCommand, memoryCommandAccepts } from "../../src/memory/commands";
import { stagePendingWrite } from "../../src/memory/pending";
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
    expect(memoryCommandAccepts([])).toBe(false);
  });
});

describe("decideMemoryCommand", () => {
  test("pending: reports none when nothing is staged", () => {
    const ctx = makeCtx();
    const result = decideMemoryCommand(["pending"], ctx);
    expect(result.changed).toBe(false);
    expect(result.lines[0]).toContain("No staged");
  });

  test("pending/diff/approve/reject: full staged-write lifecycle", () => {
    const ctx = makeCtx();
    const staged = stagePendingWrite(
      { scope: "user", action: "add", content: "prefers tabs", reason: "r", durable: true },
      ctx,
      new Date(),
    );

    const pending = decideMemoryCommand(["pending"], ctx);
    expect(pending.lines[0]).toContain(staged.id);
    expect(pending.lines[0]).toContain("[user]");

    const diff = decideMemoryCommand(["diff", staged.id], ctx);
    expect(diff.lines.some((l) => l.includes("prefers tabs"))).toBe(true);

    const rejected = decideMemoryCommand(["reject", staged.id], ctx);
    expect(rejected.changed).toBe(true);
    expect(decideMemoryCommand(["pending"], ctx).lines[0]).toContain("No staged");
  });

  test("approve: applies the write and reports success", () => {
    const ctx = makeCtx();
    const staged = stagePendingWrite(
      { scope: "user", action: "add", content: "prefers tabs", reason: "r", durable: true },
      ctx,
      new Date(),
    );
    const result = decideMemoryCommand(["approve", staged.id], ctx);
    expect(result.changed).toBe(true);
    expect(result.lines[0]).toContain("Approved");
  });

  test("diff/approve/reject on an unknown id report no match and change nothing", () => {
    const ctx = makeCtx();
    for (const sub of ["diff", "approve", "reject"]) {
      const result = decideMemoryCommand([sub, "deadbeef"], ctx);
      expect(result.changed).toBe(false);
      expect(result.lines[0]).toContain("No staged write matches");
    }
  });

  test("approval on|off toggles SERI_MEMORY_APPROVAL and loadMemoryConfig reflects it", () => {
    const ctx = makeCtx();
    const off = decideMemoryCommand(["approval", "off"], ctx);
    expect(off.changed).toBe(true);
    expect(loadMemoryConfig(ctx.configDir).approvalRequired).toBe(false);

    const on = decideMemoryCommand(["approval", "on"], ctx);
    expect(on.changed).toBe(true);
    expect(loadMemoryConfig(ctx.configDir).approvalRequired).toBe(true);
  });

  test("an unknown approval arg returns a usage line and changed: false", () => {
    const ctx = makeCtx();
    const result = decideMemoryCommand(["approval"], ctx);
    expect(result.changed).toBe(false);
    expect(result.lines[0]).toContain("Usage:");
  });

  test("archivist on|off toggles SERI_ARCHIVIST_ENABLED and loadMemoryConfig reflects it", () => {
    const ctx = makeCtx();
    const off = decideMemoryCommand(["archivist", "off"], ctx);
    expect(off.changed).toBe(true);
    expect(loadMemoryConfig(ctx.configDir).archivistEnabled).toBe(false);

    const on = decideMemoryCommand(["archivist", "on"], ctx);
    expect(on.changed).toBe(true);
    expect(loadMemoryConfig(ctx.configDir).archivistEnabled).toBe(true);
  });

  test("archivist with no arg or an invalid arg returns a usage line and changed: false", () => {
    const ctx = makeCtx();
    expect(decideMemoryCommand(["archivist"], ctx)).toEqual({
      lines: [
        "Usage: /memory pending | diff <id|all> | approve <id|all> | reject <id|all> | approval on|off | archivist on|off",
      ],
      changed: false,
    });
    expect(decideMemoryCommand(["archivist", "maybe"], ctx).changed).toBe(false);
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
    expect(result.changed).toBe(false);
    expect(result.lines.some((l) => l.includes("a fine entry"))).toBe(true);
    expect(result.lines.some((l) => l.startsWith("Could not diff"))).toBe(true);
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
    expect(result.changed).toBe(true);
    expect(result.lines).toHaveLength(3);
    expect(decideMemoryCommand(["pending"], ctx).lines[0]).toContain("No staged");
  });
});
