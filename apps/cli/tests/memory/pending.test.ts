import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getPendingDir } from "../../src/config/paths";
import {
  approvePending,
  diffPending,
  listPending,
  pendingPath,
  rejectPending,
  resolvePendingRef,
  stagePendingWrite,
} from "../../src/memory/pending";
import { loadMemoryFile, type MemoryContext, memoryFilePath } from "../../src/memory/store";

let configDir: string | undefined;
function makeCtx(worktree = "/home/x/harness"): MemoryContext {
  configDir = mkdtempSync(join(tmpdir(), "seri-memory-"));
  return { configDir, worktree };
}

afterEach(() => {
  if (configDir !== undefined) rmSync(configDir, { recursive: true, force: true });
  configDir = undefined;
});

describe("stagePendingWrite / listPending", () => {
  test("staging writes a .pending file under <configDir>/pending/<scope>/<id>.pending and leaves the live file untouched (byte-identical to a captured, differing before)", () => {
    const ctx = makeCtx();
    const livePath = memoryFilePath("user", ctx);
    const before = existsSync(livePath) ? readFileSync(livePath, "utf8") : "";
    expect(before).not.toContain("prefers tabs");

    const staged = stagePendingWrite(
      {
        scope: "user",
        action: "add",
        content: "prefers tabs",
        reason: "user said so",
        durable: true,
      },
      ctx,
      new Date("2026-08-11T00:00:00Z"),
    );

    expect(staged.id).toMatch(/^[0-9a-f]{12}$/);
    const path = pendingPath(ctx.configDir, "user", staged.id);
    expect(existsSync(path)).toBe(true);
    expect(path).toBe(join(getPendingDir(ctx.configDir), "user", `${staged.id}.pending`));

    const liveAfterStage = existsSync(livePath) ? readFileSync(livePath, "utf8") : "";
    expect(liveAfterStage).toBe(before);
  });

  test("listPending reports id, scope, and a one-line summary", () => {
    const ctx = makeCtx();
    const staged = stagePendingWrite(
      {
        scope: "memory-global",
        action: "add",
        content: "uses bun test",
        reason: "r",
        durable: true,
      },
      ctx,
      new Date(),
    );
    const pending = listPending(ctx.configDir);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(staged.id);
    expect(pending[0].scope).toBe("memory-global");
    expect(pending[0].content).toBe("uses bun test");
  });

  test("a malformed .pending file is skipped with a warning, not fatal", () => {
    const ctx = makeCtx();
    stagePendingWrite(
      { scope: "user", action: "add", content: "ok", reason: "r", durable: true },
      ctx,
      new Date(),
    );
    const dir = join(getPendingDir(ctx.configDir), "user");
    writeFileSync(join(dir, "broken.pending"), "not json");
    const warnings: string[] = [];
    const pending = listPending(ctx.configDir, (m) => warnings.push(m));
    expect(pending).toHaveLength(1);
    expect(warnings.length).toBe(1);
  });
});

describe("resolvePendingRef", () => {
  test("resolves an unambiguous prefix, and 'all' returns everything", () => {
    const ctx = makeCtx();
    const a = stagePendingWrite(
      { scope: "user", action: "add", content: "a", reason: "r", durable: true },
      ctx,
      new Date(),
    );
    stagePendingWrite(
      { scope: "memory-global", action: "add", content: "b", reason: "r", durable: true },
      ctx,
      new Date(),
    );

    expect(resolvePendingRef(ctx.configDir, a.id)).toHaveLength(1);
    expect(resolvePendingRef(ctx.configDir, a.id.slice(0, 4))).toHaveLength(1);
    expect(resolvePendingRef(ctx.configDir, "all")).toHaveLength(2);
  });

  test("throws on an ambiguous prefix", () => {
    const ctx = makeCtx();
    // Written directly at their target paths (not via stagePendingWrite, whose id is random) so
    // the shared "aaaa" prefix is deterministic rather than left to chance.
    const base = {
      stagedAt: new Date().toISOString(),
      scope: "user" as const,
      action: "add" as const,
      content: "x",
      reason: "r",
      durable: true,
      entryDate: "2026-08-11",
    };
    for (const id of ["aaaa11111111", "aaaa22222222"]) {
      const path = pendingPath(ctx.configDir, "user", id);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ ...base, id }));
    }
    expect(() => resolvePendingRef(ctx.configDir, "aaaa")).toThrow(
      /Ambiguous id "aaaa" — matches 2 staged writes\./,
    );
  });
});

describe("diffPending / approvePending / rejectPending", () => {
  test("diff renders +/- lines and both char/cap headers", () => {
    const ctx = makeCtx();
    const staged = stagePendingWrite(
      {
        scope: "user",
        action: "add",
        content: "prefers tabs",
        reason: "user said so",
        durable: true,
      },
      ctx,
      new Date("2026-08-11T00:00:00Z"),
    );
    const { lines } = diffPending(ctx.configDir, staged);
    expect(lines.some((l) => l.startsWith("Reason: user said so"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Durable: yes"))).toBe(true);
    expect(lines.some((l) => l.startsWith("--- USER.md (live,"))).toBe(true);
    expect(lines.some((l) => l.startsWith("+++ USER.md (if approved,"))).toBe(true);
    expect(lines.some((l) => l.startsWith("+ - [2026-08-11] prefers tabs"))).toBe(true);
  });

  test("reject unlinks the staged file and leaves the live file byte-identical", () => {
    const ctx = makeCtx();
    const livePath = memoryFilePath("user", ctx);
    const before = existsSync(livePath) ? readFileSync(livePath, "utf8") : "";
    const staged = stagePendingWrite(
      { scope: "user", action: "add", content: "x", reason: "r", durable: true },
      ctx,
      new Date(),
    );

    rejectPending(ctx.configDir, staged);

    expect(existsSync(pendingPath(ctx.configDir, "user", staged.id))).toBe(false);
    expect(existsSync(livePath) ? readFileSync(livePath, "utf8") : "").toBe(before);
  });

  test("approve changes the live file and removes the staged file", () => {
    const ctx = makeCtx();
    const livePath = memoryFilePath("user", ctx);
    const staged = stagePendingWrite(
      { scope: "user", action: "add", content: "prefers tabs", reason: "r", durable: true },
      ctx,
      new Date("2026-08-11T00:00:00Z"),
    );

    const { path } = approvePending(ctx.configDir, staged);

    expect(path).toBe(livePath);
    expect(readFileSync(livePath, "utf8")).toContain("prefers tabs");
    expect(existsSync(pendingPath(ctx.configDir, "user", staged.id))).toBe(false);
  });

  test("approve all applies writes staged in all three scopes to the three correct paths, and pending then reports none", () => {
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

    for (const p of resolvePendingRef(ctx.configDir, "all")) approvePending(ctx.configDir, p);

    expect(loadMemoryFile("user", ctx).text).toContain("u");
    expect(loadMemoryFile("memory-global", ctx).text).toContain("g");
    expect(loadMemoryFile("memory-project", ctx).text).toContain("p");
    expect(listPending(ctx.configDir)).toHaveLength(0);
  });

  test("two staged adds that individually fit but jointly exceed the cap: the first approve succeeds, the second reports the overage and leaves its .pending file present", () => {
    const ctx = makeCtx();
    const first = stagePendingWrite(
      { scope: "user", action: "add", content: "x".repeat(1_300), reason: "r", durable: true },
      ctx,
      new Date(),
    );
    const second = stagePendingWrite(
      { scope: "user", action: "add", content: "y".repeat(100), reason: "r", durable: true },
      ctx,
      new Date(),
    );

    approvePending(ctx.configDir, first);
    expect(() => approvePending(ctx.configDir, second)).toThrow(/over its 1375-char cap/);
    expect(existsSync(pendingPath(ctx.configDir, "user", second.id))).toBe(true);
  });
});
