import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { loadVerifyConfig } from "../../src/config/config";
import { createArchivistState } from "../../src/memory/archivist";
import { loadMemory } from "../../src/memory/store";
import { DISPATCH_TOOL_NAME } from "../../src/provider/tools";
import { driveLoop } from "../../src/runtime/drive";
import type { PreparedRun } from "../../src/runtime/prepare";
import { deliverSignal, onSignalCancel } from "../../src/signals";
import { fakeRunLoop } from "../cli/fakeRunLoop";

let dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seri-drive-opts-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function preparedStub(): PreparedRun {
  const dir = makeDir();
  return {
    session: {
      id: "sess",
      cwd: dir,
      systemPrompt: "sys",
      permissionMode: "read-only",
      model: "openai/gpt-oss-120b",
      provider: "groq",
      messages: [{ role: "user", content: "hi" }],
    },
    storeDir: dir,
    tools: {},
    model: new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream() }) }),
    permissionMode: "read-only",
    worktree: dir,
    allowedTools: [],
    catalog: { fetchedAt: "", entries: [] },
    catalogEntry: undefined,
    route: {
      model: "openai/gpt-oss-120b",
      provider: "groq",
      rerouted: false,
      viaGateway: false,
    },
    plan: null,
    checkpointer: Object.assign(() => {}, {
      onAfterMutation: () => {},
      invalidate: () => {},
    }),
    verifyConfig: loadVerifyConfig(dir),
    memory: loadMemory({ configDir: dir, worktree: dir }),
    trajectory: {
      recordLoopEvent: () => {},
      recordChildUsage: () => {},
      recordChildEvent: () => {},
      recordCheckpoint: () => {},
      recordArchivist: () => {},
    },
    preMountMessages: [],
  };
}

function unusedCtx(configDir: string) {
  return {
    resuming: false as const,
    resumeId: undefined,
    taskText: "hi",
    sessionsDir: join(configDir, "sessions"),
    checkpointsDir: join(configDir, "checkpoints"),
    permissionsDir: configDir,
    configDir,
    effortFlag: undefined,
    detailFlag: false,
    cwd: configDir,
  };
}

describe("driveLoop options", () => {
  test("composeSubagents false omits dispatch_subagents; the default still adds it", async () => {
    const prepared = preparedStub();
    const ctx = unusedCtx(prepared.session.cwd);
    const emptyArchivist = createArchivistState(prepared.session);
    const withDispatch = fakeRunLoop();
    await driveLoop(
      prepared,
      ctx,
      { runLoop: withDispatch.fake },
      1,
      () => {},
      () => "read-only",
      () => {},
      async () => "no",
      emptyArchivist,
    );
    expect(DISPATCH_TOOL_NAME in (withDispatch.capture()?.tools ?? {})).toBe(true);

    const withoutDispatch = fakeRunLoop();
    await driveLoop(
      preparedStub(),
      ctx,
      { runLoop: withoutDispatch.fake },
      1,
      () => {},
      () => "read-only",
      () => {},
      async () => "no",
      createArchivistState(prepared.session),
      undefined,
      { composeSubagents: false },
    );
    expect(DISPATCH_TOOL_NAME in (withoutDispatch.capture()?.tools ?? {})).toBe(false);
  });

  test("bindProcessCancel false leaves the process cancel slot untouched", async () => {
    let preserved = false;
    const unregister = onSignalCancel(() => {
      preserved = true;
    });
    try {
      const prepared = preparedStub();
      await driveLoop(
        prepared,
        unusedCtx(prepared.session.cwd),
        { runLoop: fakeRunLoop().fake },
        1,
        () => {},
        () => "read-only",
        () => {},
        async () => "no",
        createArchivistState(prepared.session),
        undefined,
        { bindProcessCancel: false },
      );
      deliverSignal("SIGINT");
      expect(preserved).toBe(true);
    } finally {
      unregister();
    }
  });

  test("an injected signal aborts the same controller the loop is driven with", async () => {
    const abort = new AbortController();
    const prepared = preparedStub();
    let loopSignal: AbortSignal | undefined;
    const loop = driveLoop(
      prepared,
      unusedCtx(prepared.session.cwd),
      {
        runLoop: async function* (opts) {
          loopSignal = opts.signal;
          await new Promise<void>((resolve) => {
            if (opts.signal?.aborted) resolve();
            else opts.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          yield { type: "done", reason: "aborted" as const };
        },
      },
      1,
      () => {},
      () => "read-only",
      () => {},
      async () => "no",
      createArchivistState(prepared.session),
      undefined,
      { signal: abort.signal, bindProcessCancel: false },
    );
    abort.abort();
    const result = await loop;
    expect(result.doneReason).toBe("aborted");
    expect(loopSignal?.aborted).toBe(true);
  });
});
