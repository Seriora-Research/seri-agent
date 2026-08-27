import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneTrajectories } from "../../src/trajectory/prune";

describe("pruneTrajectories", () => {
  test("deletes jsonl older than the window and keeps keepSessionId", () => {
    const dir = mkdtempSync(join(tmpdir(), "seri-traj-prune-"));
    try {
      const oldPath = join(dir, "old.jsonl");
      const midPath = join(dir, "mid.jsonl");
      const livePath = join(dir, "live.jsonl");
      writeFileSync(oldPath, "{}\n");
      writeFileSync(midPath, "{}\n");
      writeFileSync(livePath, "{}\n");
      const now = new Date("2026-08-27T00:00:00Z");
      const day = 24 * 60 * 60 * 1000;
      utimesSync(oldPath, new Date(now.getTime() - 31 * day), new Date(now.getTime() - 31 * day));
      utimesSync(midPath, new Date(now.getTime() - 15 * day), new Date(now.getTime() - 15 * day));
      utimesSync(livePath, now, now);
      writeFileSync(join(dir, "notes.txt"), "leave me");

      const deleted = pruneTrajectories(dir, { now, retentionDays: 30, keepSessionId: "live" });
      expect(deleted).toEqual([oldPath]);
      expect(readdirSync(dir).sort()).toEqual(["live.jsonl", "mid.jsonl", "notes.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing directory returns an empty list", () => {
    expect(
      pruneTrajectories(join(tmpdir(), "seri-traj-missing-dir-does-not-exist"), {
        now: new Date(),
        retentionDays: 30,
      }),
    ).toEqual([]);
  });
});
