import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findMostRecentSession,
  loadSession,
  type SessionState,
  saveSession,
} from "../../src/session/session";

let sessionsDir: string;

beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), "seri-session-test-"));
});

afterEach(() => {
  rmSync(sessionsDir, { recursive: true, force: true });
});

describe("saveSession / loadSession", () => {
  test("round-trips a session exactly", () => {
    const state: SessionState = {
      id: "abc123",
      cwd: "C:\\repo",
      systemPrompt: "You are seri, a coding agent.",
      permissionMode: "approve-each",
      messages: [
        { role: "user", content: "do the thing" },
        { role: "assistant", content: "on it" },
        { role: "tool", content: { name: "bash", result: "ok" } },
      ],
    };

    saveSession(state, sessionsDir);

    expect(loadSession("abc123", sessionsDir)).toEqual(state);
  });

  test("creates sessionsDir if it doesn't exist yet", () => {
    const freshDir = join(sessionsDir, "nested", "sessions");
    const state: SessionState = {
      id: "s1",
      cwd: ".",
      systemPrompt: "",
      permissionMode: "auto",
      messages: [],
    };

    saveSession(state, freshDir);

    expect(loadSession("s1", freshDir)).toEqual(state);
  });

  test("loadSession throws a clear error for a missing id", () => {
    expect(() => loadSession("missing", sessionsDir)).toThrow(
      `Session "missing" not found in ${sessionsDir}`,
    );
  });
});

describe("saveSession (JSONL append-only persistence)", () => {
  test("the first save for an id is a full write, and every save after it appends only the new messages", () => {
    const writeSpy = spyOn(fs, "writeFileSync");
    const appendSpy = spyOn(fs, "appendFileSync");

    const state: SessionState = {
      id: "hot-path",
      cwd: ".",
      systemPrompt: "",
      permissionMode: "auto",
      messages: [],
    };
    saveSession(state, sessionsDir);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledTimes(0);

    state.messages.push({ role: "user", content: "hi" });
    saveSession(state, sessionsDir);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledTimes(1);

    state.messages.push({ role: "assistant", content: "hello" });
    saveSession(state, sessionsDir);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledTimes(2);

    expect(loadSession("hot-path", sessionsDir)).toEqual(state);

    writeSpy.mockRestore();
    appendSpy.mockRestore();
  });

  // The full-rewrite path goes through atomicWriteFile.ts's shared helper rather than a locally
  // reimplemented temp-file + rename, which is what gives session saves the same orphaned-tmp-file
  // sweep config.json/memory/permissions writes already have — a session save interrupted by a
  // killed process previously left a `.<id>.jsonl.<pid>.tmp` file in sessionsDir forever, and a
  // session transcript is exactly the kind of content (pasted secrets, full conversation) that
  // orphan shouldn't sit on disk indefinitely.
  test("a full-rewrite save sweeps a stale tmp file left behind by a dead process", () => {
    const target = join(sessionsDir, "swept.jsonl");
    const stalePath = `${target}.999999999.deadbeef.tmp`;
    writeFileSync(stalePath, "orphaned content");

    saveSession(
      { id: "swept", cwd: ".", systemPrompt: "", permissionMode: "auto", messages: [] },
      sessionsDir,
    );

    expect(fs.existsSync(stalePath)).toBe(false);
  });

  test("does nothing when a save repeats the same header and the same message count", () => {
    const state: SessionState = {
      id: "no-op",
      cwd: ".",
      systemPrompt: "",
      permissionMode: "auto",
      messages: [{ role: "user", content: "hi" }],
    };
    saveSession(state, sessionsDir);

    const writeSpy = spyOn(fs, "writeFileSync");
    const appendSpy = spyOn(fs, "appendFileSync");
    saveSession(state, sessionsDir);

    expect(writeSpy).toHaveBeenCalledTimes(0);
    expect(appendSpy).toHaveBeenCalledTimes(0);

    writeSpy.mockRestore();
    appendSpy.mockRestore();
  });

  test("a shrink (as /rewind produces) triggers a full rewrite with the correct final content", () => {
    const state: SessionState = {
      id: "shrink",
      cwd: ".",
      systemPrompt: "",
      permissionMode: "auto",
      messages: [{ n: 1 }, { n: 2 }, { n: 3 }],
    };
    saveSession(state, sessionsDir);

    const writeSpy = spyOn(fs, "writeFileSync");
    const appendSpy = spyOn(fs, "appendFileSync");
    const shrunk: SessionState = { ...state, messages: state.messages.slice(0, 1) };
    saveSession(shrunk, sessionsDir);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledTimes(0);
    // Not just "a rewrite happened" — the append log genuinely cannot shrink, so this also proves
    // the rewrite produced the right file rather than one still carrying the trimmed messages.
    expect(loadSession("shrink", sessionsDir)).toEqual(shrunk);

    writeSpy.mockRestore();
    appendSpy.mockRestore();
  });

  test("a header-only change (e.g. /mode) triggers a full rewrite rather than a stale header", () => {
    const state: SessionState = {
      id: "header-change",
      cwd: ".",
      systemPrompt: "",
      permissionMode: "auto",
      messages: [{ n: 1 }],
    };
    saveSession(state, sessionsDir);

    const writeSpy = spyOn(fs, "writeFileSync");
    const appendSpy = spyOn(fs, "appendFileSync");
    const changed: SessionState = { ...state, permissionMode: "approve-each" };
    saveSession(changed, sessionsDir);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledTimes(0);
    expect(loadSession("header-change", sessionsDir)).toEqual(changed);

    writeSpy.mockRestore();
    appendSpy.mockRestore();
  });

  test("loadSession seeds save tracking, so a resumed session appends new messages instead of duplicating them", () => {
    // Written directly rather than through saveSession, to simulate a session on disk that this
    // process has never called saveSession for — the only way persistedCounts/persistedHeaders can
    // be unseeded for an id whose file already exists.
    const header = { id: "resumed", cwd: ".", systemPrompt: "", permissionMode: "auto" as const };
    writeFileSync(
      join(sessionsDir, "resumed.jsonl"),
      `${JSON.stringify(header)}\n${JSON.stringify({ n: 1 })}\n`,
    );

    const loaded = loadSession<{ n: number }>("resumed", sessionsDir);
    expect(loaded.messages).toEqual([{ n: 1 }]);

    const writeSpy = spyOn(fs, "writeFileSync");
    const appendSpy = spyOn(fs, "appendFileSync");
    saveSession({ ...loaded, messages: [...loaded.messages, { n: 2 }] }, sessionsDir);

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledTimes(0);
    expect(loadSession("resumed", sessionsDir).messages).toEqual([{ n: 1 }, { n: 2 }]);

    writeSpy.mockRestore();
    appendSpy.mockRestore();
  });

  // A torn appendFileSync write (process killed, disk full) leaves a malformed trailing line —
  // simulated here by writing the header and one good message, then a hand-truncated fragment of a
  // second that never closes its JSON.
  test("loadSession drops a truncated trailing line instead of throwing and losing the whole session", () => {
    const header = { id: "torn", cwd: ".", systemPrompt: "", permissionMode: "auto" as const };
    writeFileSync(
      join(sessionsDir, "torn.jsonl"),
      `${JSON.stringify(header)}\n${JSON.stringify({ n: 1 })}\n{"n": 2, "text": "unfinis`,
    );

    const loaded = loadSession<{ n: number }>("torn", sessionsDir);
    expect(loaded.messages).toEqual([{ n: 1 }]);
  });

  test("a load that dropped a truncated line forces a full rewrite on the next save, not an append onto the fragment", () => {
    const header = { id: "torn2", cwd: ".", systemPrompt: "", permissionMode: "auto" as const };
    writeFileSync(
      join(sessionsDir, "torn2.jsonl"),
      `${JSON.stringify(header)}\n${JSON.stringify({ n: 1 })}\n{"n": 2, "text": "unfinis`,
    );

    const loaded = loadSession<{ n: number }>("torn2", sessionsDir);

    const writeSpy = spyOn(fs, "writeFileSync");
    const appendSpy = spyOn(fs, "appendFileSync");
    saveSession({ ...loaded, messages: [...loaded.messages, { n: 3 }] }, sessionsDir);

    expect(appendSpy).toHaveBeenCalledTimes(0);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(loadSession("torn2", sessionsDir).messages).toEqual([{ n: 1 }, { n: 3 }]);

    writeSpy.mockRestore();
    appendSpy.mockRestore();
  });

  test("falls back to a full rewrite when the file was deleted out of band, instead of appending onto nothing", () => {
    const state: SessionState = {
      id: "deleted",
      cwd: ".",
      systemPrompt: "",
      permissionMode: "auto",
      messages: [{ n: 1 }],
    };
    saveSession(state, sessionsDir);
    fs.rmSync(join(sessionsDir, "deleted.jsonl"));

    const grown: SessionState = { ...state, messages: [...state.messages, { n: 2 }] };
    saveSession(grown, sessionsDir);

    // A headerless append here would leave loadSession misparsing the first message as the header,
    // silently returning id/cwd/permissionMode all undefined instead of the real session.
    expect(loadSession("deleted", sessionsDir)).toEqual(grown);
  });
});

describe("findMostRecentSession", () => {
  test("returns the id of the most recently modified session", () => {
    saveSession(
      { id: "first", cwd: ".", systemPrompt: "", permissionMode: "auto", messages: [] },
      sessionsDir,
    );
    saveSession(
      { id: "second", cwd: ".", systemPrompt: "", permissionMode: "auto", messages: [] },
      sessionsDir,
    );
    saveSession(
      { id: "third", cwd: ".", systemPrompt: "", permissionMode: "auto", messages: [] },
      sessionsDir,
    );

    // Explicit mtimes rather than relying on real-time gaps between writes, which can be
    // too small to distinguish on a fast filesystem.
    const base = new Date("2026-01-01T00:00:00Z");
    utimesSync(join(sessionsDir, "first.jsonl"), base, base);
    utimesSync(
      join(sessionsDir, "second.jsonl"),
      new Date(base.getTime() + 60_000),
      new Date(base.getTime() + 60_000),
    );
    utimesSync(
      join(sessionsDir, "third.jsonl"),
      new Date(base.getTime() + 30_000),
      new Date(base.getTime() + 30_000),
    );

    expect(findMostRecentSession(sessionsDir)).toBe("second");
  });

  test("returns undefined for an empty directory", () => {
    expect(findMostRecentSession(sessionsDir)).toBeUndefined();
  });

  test("returns undefined for a non-existent directory", () => {
    expect(findMostRecentSession(join(sessionsDir, "does-not-exist"))).toBeUndefined();
  });
});
