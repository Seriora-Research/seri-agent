import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTrajectoryWriter, readTrajectory } from "../../src/trajectory/writer";

function writerOpts(
  dir: string,
  extras: Partial<Parameters<typeof createTrajectoryWriter>[0]> = {},
) {
  return {
    dir,
    sessionId: "sess-1",
    cwd: "/tmp/proj",
    enabled: true,
    retentionDays: 30,
    onWarning: () => {},
    ...extras,
  };
}

describe("createTrajectoryWriter", () => {
  test("first record writes a header then seq 1; second record is seq 2", () => {
    const parent = mkdtempSync(join(tmpdir(), "seri-traj-writer-"));
    const dir = join(parent, "trajectories");
    try {
      const writer = createTrajectoryWriter(writerOpts(dir));
      writer.recordLoopEvent({ type: "done", reason: "no-tool-call" });
      writer.recordLoopEvent({ type: "retry", attempt: 1 });
      const lines = readTrajectory(join(dir, "sess-1.jsonl"));
      expect(lines[0]).toMatchObject({ v: 1, kind: "header", sessionId: "sess-1" });
      expect(lines[1]).toMatchObject({ kind: "done", seq: 1, reason: "no-tool-call" });
      expect(lines[2]).toMatchObject({ kind: "retry", seq: 2, attempt: 1 });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("disabled writer creates no trajectories directory", () => {
    const parent = mkdtempSync(join(tmpdir(), "seri-traj-disabled-"));
    try {
      const writer = createTrajectoryWriter(
        writerOpts(join(parent, "trajectories"), { enabled: false }),
      );
      writer.recordLoopEvent({ type: "done", reason: "no-tool-call" });
      expect(readdirSync(parent)).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("I/O failure warns and does not throw", () => {
    const parent = mkdtempSync(join(tmpdir(), "seri-traj-io-"));
    const warnings: string[] = [];
    try {
      const writer = createTrajectoryWriter(
        writerOpts(join(parent, "trajectories"), {
          onWarning: (message) => warnings.push(message),
          appendFileSync: () => {
            throw new Error("ENOSPC");
          },
        }),
      );
      expect(() => writer.recordLoopEvent({ type: "done", reason: "aborted" })).not.toThrow();
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("ENOSPC");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("readTrajectory skips a torn last line", () => {
    const parent = mkdtempSync(join(tmpdir(), "seri-traj-torn-"));
    const dir = join(parent, "trajectories");
    mkdirSync(dir);
    const path = join(dir, "sess-1.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({ v: 1, kind: "header", sessionId: "sess-1", cwd: "/tmp", startedAt: "t" })}\n{"kind":"done"\n`,
    );
    try {
      const lines = readTrajectory(path);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ kind: "header" });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("text-delta does not write or bump seq", () => {
    const parent = mkdtempSync(join(tmpdir(), "seri-traj-delta-"));
    const dir = join(parent, "trajectories");
    try {
      const writer = createTrajectoryWriter(writerOpts(dir));
      writer.recordLoopEvent({ type: "text-delta", text: "hi" });
      writer.recordLoopEvent({ type: "done", reason: "no-tool-call" });
      const lines = readTrajectory(join(dir, "sess-1.jsonl"));
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatchObject({ kind: "done", seq: 1 });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("write_file tool_result with verification writes tool_result and check_result", () => {
    const parent = mkdtempSync(join(tmpdir(), "seri-traj-check-"));
    const dir = join(parent, "trajectories");
    try {
      const writer = createTrajectoryWriter(writerOpts(dir));
      writer.recordLoopEvent({
        type: "tool-call",
        name: "write_file",
        args: { path: "a.ts", content: "x" },
      });
      writer.recordLoopEvent({
        type: "tool-result",
        name: "write_file",
        result: {
          written: true,
          verification: { status: "ok", command: "tsc", elapsedMs: 1 },
        },
      });
      const lines = readTrajectory(join(dir, "sess-1.jsonl"));
      const kinds = lines.map((line) => (line as { kind: string }).kind);
      expect(kinds).toEqual(["header", "tool_call", "tool_result", "check_result"]);
      expect(lines[3]).toMatchObject({
        kind: "check_result",
        path: "a.ts",
        outcome: { status: "ok" },
      });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("reopening an existing file continues seq and does not write a second header", () => {
    const parent = mkdtempSync(join(tmpdir(), "seri-traj-reopen-"));
    const dir = join(parent, "trajectories");
    try {
      const first = createTrajectoryWriter(writerOpts(dir));
      first.recordLoopEvent({ type: "done", reason: "no-tool-call" });
      const second = createTrajectoryWriter(writerOpts(dir));
      second.recordLoopEvent({ type: "retry", attempt: 1 });
      const lines = readTrajectory(join(dir, "sess-1.jsonl"));
      expect(lines.filter((line) => (line as { kind: string }).kind === "header")).toHaveLength(1);
      expect(lines[1]).toMatchObject({ kind: "done", seq: 1 });
      expect(lines[2]).toMatchObject({ kind: "retry", seq: 2 });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a torn last line is truncated before the next append", () => {
    const parent = mkdtempSync(join(tmpdir(), "seri-traj-torn-append-"));
    const dir = join(parent, "trajectories");
    mkdirSync(dir);
    const path = join(dir, "sess-1.jsonl");
    const header = JSON.stringify({
      v: 1,
      kind: "header",
      sessionId: "sess-1",
      cwd: "/tmp",
      startedAt: "t",
    });
    const done = JSON.stringify({
      v: 1,
      ts: "t",
      seq: 1,
      sessionId: "sess-1",
      actor: { type: "parent" },
      kind: "done",
      reason: "no-tool-call",
    });
    writeFileSync(path, `${header}\n${done}\n{"kind":"retry"`);
    try {
      const writer = createTrajectoryWriter(writerOpts(dir));
      writer.recordLoopEvent({ type: "retry", attempt: 1 });
      const raw = readFileSync(path, "utf8");
      expect(raw.includes('{"kind":"retry"\n')).toBe(false);
      const lines = readTrajectory(path);
      expect(lines.map((line) => (line as { kind: string }).kind)).toEqual([
        "header",
        "done",
        "retry",
      ]);
      expect(lines[2]).toMatchObject({ kind: "retry", seq: 2 });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("recordChildEvent ignores usage; recordChildUsage is the only child usage line", () => {
    const parent = mkdtempSync(join(tmpdir(), "seri-traj-child-usage-"));
    const dir = join(parent, "trajectories");
    try {
      const writer = createTrajectoryWriter(writerOpts(dir));
      const usage = {
        inputTokens: 7,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: 3,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: 10,
      };
      writer.recordChildEvent({
        childId: "t1:0",
        role: "explore",
        goal: "look",
        event: { type: "usage", usage },
      });
      writer.recordChildUsage(usage, undefined);
      const lines = readTrajectory(join(dir, "sess-1.jsonl"));
      const usageLines = lines.filter((line) => (line as { kind: string }).kind === "usage");
      expect(usageLines).toHaveLength(1);
      expect(usageLines[0]).toMatchObject({ kind: "usage", source: "child" });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a non-edit error does not write edit_outcome", () => {
    const parent = mkdtempSync(join(tmpdir(), "seri-traj-non-edit-"));
    const dir = join(parent, "trajectories");
    try {
      const writer = createTrajectoryWriter(writerOpts(dir));
      writer.recordLoopEvent({
        type: "error",
        error: 'Tool "bash" threw during execution: Error: ENOENT',
      });
      const kinds = readTrajectory(join(dir, "sess-1.jsonl")).map(
        (line) => (line as { kind: string }).kind,
      );
      expect(kinds).toEqual(["header", "error"]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a disabled writer still prunes an existing directory and does not create one", () => {
    const parent = mkdtempSync(join(tmpdir(), "seri-traj-disabled-prune-"));
    const dir = join(parent, "trajectories");
    mkdirSync(dir);
    const oldPath = join(dir, "old.jsonl");
    writeFileSync(oldPath, "{}\n");
    const now = new Date("2026-08-27T00:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    utimesSync(oldPath, new Date(now.getTime() - 31 * day), new Date(now.getTime() - 31 * day));
    try {
      const writer = createTrajectoryWriter(writerOpts(dir, { enabled: false, now: () => now }));
      writer.recordLoopEvent({ type: "done", reason: "no-tool-call" });
      expect(readdirSync(dir)).toEqual([]);
      expect(readdirSync(parent)).toEqual(["trajectories"]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a disabled start keeps this session's jsonl so later enable resumes it", () => {
    const parent = mkdtempSync(join(tmpdir(), "seri-traj-keep-session-"));
    const dir = join(parent, "trajectories");
    mkdirSync(dir);
    const path = join(dir, "sess-1.jsonl");
    const stale = join(dir, "other.jsonl");
    const header = JSON.stringify({
      v: 1,
      kind: "header",
      sessionId: "sess-1",
      cwd: "/tmp",
      startedAt: "t",
    });
    const done = JSON.stringify({
      v: 1,
      ts: "t",
      seq: 1,
      sessionId: "sess-1",
      actor: { type: "parent" },
      kind: "done",
      reason: "no-tool-call",
    });
    writeFileSync(path, `${header}\n${done}\n`);
    writeFileSync(stale, "{}\n");
    const now = new Date("2026-08-27T00:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    utimesSync(path, new Date(now.getTime() - 31 * day), new Date(now.getTime() - 31 * day));
    utimesSync(stale, new Date(now.getTime() - 31 * day), new Date(now.getTime() - 31 * day));
    try {
      const writer = createTrajectoryWriter(writerOpts(dir, { enabled: false, now: () => now }));
      expect(readdirSync(dir)).toEqual(["sess-1.jsonl"]);
      writer.setEnabled(true);
      writer.recordLoopEvent({ type: "retry", attempt: 1 });
      const lines = readTrajectory(path);
      expect(lines.filter((line) => (line as { kind: string }).kind === "header")).toHaveLength(1);
      expect(lines[2]).toMatchObject({ kind: "retry", seq: 2 });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("setEnabled(false) stops appending; setEnabled(true) continues seq without a second header", () => {
    const parent = mkdtempSync(join(tmpdir(), "seri-traj-toggle-"));
    const dir = join(parent, "trajectories");
    try {
      const writer = createTrajectoryWriter(writerOpts(dir));
      writer.recordLoopEvent({ type: "done", reason: "no-tool-call" });
      writer.setEnabled(false);
      writer.recordLoopEvent({ type: "retry", attempt: 1 });
      writer.setEnabled(true);
      writer.recordLoopEvent({ type: "retry", attempt: 2 });
      const lines = readTrajectory(join(dir, "sess-1.jsonl"));
      expect(lines.filter((line) => (line as { kind: string }).kind === "header")).toHaveLength(1);
      expect(lines.map((line) => (line as { kind: string }).kind)).toEqual([
        "header",
        "done",
        "retry",
      ]);
      expect(lines[2]).toMatchObject({ kind: "retry", seq: 2, attempt: 2 });
      expect(writer.isEnabled()).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
