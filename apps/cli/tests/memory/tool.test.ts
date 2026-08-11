import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigValue } from "../../src/config/config";
import { getPendingDir } from "../../src/config/paths";
import { loadMemoryFile, type MemoryContext, memoryFilePath } from "../../src/memory/store";
import { makeMemoryWriteTool, memoryWriteInputSchema } from "../../src/memory/tool";

const MEMORY_CAP_USER = 1_375;

let configDir: string | undefined;
function makeCtx(worktree = "/home/x/harness"): MemoryContext {
  configDir = mkdtempSync(join(tmpdir(), "seri-memory-"));
  return { configDir, worktree };
}

afterEach(() => {
  if (configDir !== undefined) rmSync(configDir, { recursive: true, force: true });
  configDir = undefined;
});

// Mirrors provider/tools.ts's own tools: `execute` is called directly, the way loop.ts's own
// gate-checked path eventually invokes it, with a minimal options object.
function callTool(
  toolDef: ReturnType<typeof makeMemoryWriteTool>,
  args: Record<string, unknown>,
): Promise<unknown> {
  // biome-ignore lint/style/noNonNullAssertion: every memory_write tool built here always has `execute`.
  return toolDef.execute!(
    args as never,
    {
      toolCallId: "t1",
      messages: [],
    } as never,
  ) as Promise<unknown>;
}

describe("makeMemoryWriteTool", () => {
  test("schema rejects a call missing reason or durable, independent of action", () => {
    const missingReason = memoryWriteInputSchema.safeParse({
      scope: "user",
      action: "add",
      content: "x",
      durable: true,
    });
    const missingDurable = memoryWriteInputSchema.safeParse({
      scope: "user",
      action: "add",
      content: "x",
      reason: "r",
    });
    expect(missingReason.success).toBe(false);
    expect(missingDurable.success).toBe(false);
  });

  test("a well-formed call with both present validates", () => {
    const parsed = memoryWriteInputSchema.safeParse({
      scope: "user",
      action: "add",
      content: "prefers tabs",
      reason: "user said so",
      durable: true,
    });
    expect(parsed.success).toBe(true);
  });

  test("with the approval gate ON (default), a write is staged, not written live", async () => {
    const ctx = makeCtx();
    const toolDef = makeMemoryWriteTool(ctx);
    const result = (await callTool(toolDef, {
      scope: "user",
      action: "add",
      content: "prefers tabs",
      reason: "r",
      durable: true,
    })) as { staged: boolean };
    expect(result.staged).toBe(true);
    const livePath = memoryFilePath("user", ctx);
    expect(existsSync(livePath) ? readFileSync(livePath, "utf8") : "").toBe("");
    const pendingDir = join(getPendingDir(ctx.configDir), "user");
    expect(readdirSync(pendingDir).filter((f) => f.endsWith(".pending"))).toHaveLength(1);
  });

  test("with the approval gate OFF, a write lands directly on the live file", async () => {
    const ctx = makeCtx();
    setConfigValue("SERI_MEMORY_APPROVAL", "false", ctx.configDir);
    const toolDef = makeMemoryWriteTool(ctx);
    const result = (await callTool(toolDef, {
      scope: "user",
      action: "add",
      content: "prefers tabs",
      reason: "r",
      durable: true,
    })) as { staged: boolean };
    expect(result.staged).toBe(false);
    expect(loadMemoryFile("user", ctx).text).toContain("prefers tabs");
  });

  test("an injection-scan-tripping write reaches neither the live file nor the pending queue, and the credential rejection never carries the matched secret", async () => {
    const ctx = makeCtx();
    const toolDef = makeMemoryWriteTool(ctx);
    const secret = "gsk_abcdefghijklmnopqrstuvwxyz0123456789";
    let thrown: Error | undefined;
    try {
      await callTool(toolDef, {
        scope: "user",
        action: "add",
        content: secret,
        reason: "r",
        durable: true,
      });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.message).not.toContain(secret);

    const livePath = memoryFilePath("user", ctx);
    expect(existsSync(livePath)).toBe(false);
    const pendingDir = join(getPendingDir(ctx.configDir), "user");
    expect(existsSync(pendingDir) ? readdirSync(pendingDir) : []).toHaveLength(0);
  });

  test("an over-cap write throws before staging, and nothing is staged", async () => {
    const ctx = makeCtx();
    const toolDef = makeMemoryWriteTool(ctx);
    await expect(
      callTool(toolDef, {
        scope: "user",
        action: "add",
        content: "x".repeat(MEMORY_CAP_USER + 10),
        reason: "r",
        durable: true,
      }),
    ).rejects.toThrow(/over its 1375-char cap/);
    const pendingDir = join(getPendingDir(ctx.configDir), "user");
    expect(existsSync(pendingDir) ? readdirSync(pendingDir) : []).toHaveLength(0);
  });
});
