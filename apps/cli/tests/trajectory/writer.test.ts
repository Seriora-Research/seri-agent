import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTrajectoryWriter, readTrajectory } from "../../src/trajectory/writer";

function writerOpts(dir: string, extras: Partial<Parameters<typeof createTrajectoryWriter>[0]> = {}) {
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
});
