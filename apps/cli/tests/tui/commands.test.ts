import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_PROVIDERS, type ModelCatalog, type ModelCatalogEntry } from "@seri/model-catalog";
import type { ModelMessage } from "ai";
import {
  type CheckpointRecord,
  checkpointStoreDir,
  createCheckpointer,
  readLog,
} from "../../src/checkpoint/checkpoint";
import { isGitAvailable } from "../../src/checkpoint/shadowGit";
import { setConfigValue } from "../../src/config/config";
import type { SessionState } from "../../src/session/session";
import {
  decideModeCycle,
  decideModelPickerOpen,
  decideRestore,
  decideRewind,
  decideSetupOpen,
  decideUndo,
} from "../../src/tui/commands";

let root: string;
let storeDir: string;
let workTree: string;
let checkpointsDir: string;

const SESSION = "session-1";

function session(overrides: Partial<SessionState<ModelMessage>> = {}): SessionState<ModelMessage> {
  return {
    id: SESSION,
    cwd: workTree,
    systemPrompt: "",
    permissionMode: "approve-each",
    messages: [],
    ...overrides,
  };
}

function checkpointer() {
  return createCheckpointer({
    storeDir,
    worktree: workTree,
    sessionId: SESSION,
    onWarning: () => {},
  });
}

// decideUndo/decideRestore/decideRewind derive storeDir from `dirs.checkpointsDir` themselves
// (checkpointTarget, mirroring cli.ts) rather than taking storeDir directly, so the fixtures below
// must build their checkpoints under that same derived storeDir for the two to agree.
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "seri-tui-commands-test-"));
  checkpointsDir = join(root, "checkpoints");
  workTree = join(root, "work");
  mkdirSync(workTree, { recursive: true });
  writeFileSync(join(workTree, "a.txt"), "before\n");
  storeDir = checkpointStoreDir(checkpointsDir, workTree);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("decideModeCycle", () => {
  test("cycles the mode without mutating the session it was given", () => {
    const before = session({ permissionMode: "read-only" });
    const { next, message } = decideModeCycle(before);

    expect(before.permissionMode).toBe("read-only");
    expect(next.permissionMode).toBe("approve-each");
    expect(message).toBe(`Session ${SESSION}: permission mode is now approve-each`);
  });
});

function catalogEntry(overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return {
    id: "llama-3.3-70b-versatile",
    provider: "groq",
    displayName: "Llama 3.3 70B",
    family: "llama",
    contextWindow: 131_072,
    maxOutputTokens: 32_768,
    toolCall: true,
    reasoning: false,
    pricing: undefined,
    ...overrides,
  };
}

describe("decideModelPickerOpen", () => {
  test("keeps only entries with tool-call support", () => {
    const catalog: ModelCatalog = {
      fetchedAt: "2026-08-09T00:00:00.000Z",
      entries: [
        catalogEntry({ id: "a", toolCall: true }),
        catalogEntry({ id: "b", toolCall: false }),
        catalogEntry({ id: "c", toolCall: true }),
      ],
    };

    expect(decideModelPickerOpen(catalog, new Set()).map((row) => row.entry.id)).toEqual([
      "a",
      "c",
    ]);
  });

  // D1/D2 (feature-plan.md): a model reachable through more than one provider lands as
  // ADJACENT rows, native-then-aggregator — the same order routing-priority resolution
  // (resolveRoute) would itself choose.
  test("a multi-route model's rows land adjacently, native before aggregator", () => {
    const catalog: ModelCatalog = {
      fetchedAt: "2026-08-09T00:00:00.000Z",
      entries: [
        catalogEntry({ id: "anthropic/claude-sonnet-5", provider: "openrouter" }),
        catalogEntry({ id: "unrelated", provider: "groq" }),
        catalogEntry({ id: "claude-sonnet-5", provider: "anthropic" }),
      ],
    };

    const rows = decideModelPickerOpen(catalog, new Set());
    expect(rows.map((row) => `${row.entry.provider}:${row.entry.id}`)).toEqual([
      // The sonnet-5 GROUP's own first appearance (routeKey "anthropic/claude-sonnet-5") is the
      // openrouter entry at index 0 of the fixture, so the group as a whole sorts before the
      // "unrelated" group — but WITHIN the group, native anthropic sorts before aggregator
      // openrouter regardless of which one appeared first in the catalog.
      "anthropic:claude-sonnet-5",
      "openrouter:anthropic/claude-sonnet-5",
      "groq:unrelated",
    ]);
  });

  test("keyConfigured reflects the passed set, and alternatives counts sibling routes", () => {
    const catalog: ModelCatalog = {
      fetchedAt: "2026-08-09T00:00:00.000Z",
      entries: [
        catalogEntry({ id: "anthropic/claude-sonnet-5", provider: "openrouter" }),
        catalogEntry({ id: "claude-sonnet-5", provider: "anthropic" }),
        catalogEntry({ id: "unrelated", provider: "groq" }),
      ],
    };

    const rows = decideModelPickerOpen(catalog, new Set(["anthropic"]));
    const openrouterRow = rows.find((row) => row.entry.provider === "openrouter");
    const anthropicRow = rows.find((row) => row.entry.provider === "anthropic");
    const groqRow = rows.find((row) => row.entry.provider === "groq");

    expect(openrouterRow?.keyConfigured).toBe(false);
    expect(anthropicRow?.keyConfigured).toBe(true);
    expect(openrouterRow?.alternatives).toBe(1);
    expect(anthropicRow?.alternatives).toBe(1);
    // A model with no siblings has zero alternatives, not `undefined` or `-1`.
    expect(groqRow?.alternatives).toBe(0);
  });

  test("rerouteTo names the specific sibling a keyless row would actually reroute to", () => {
    const catalog: ModelCatalog = {
      fetchedAt: "2026-08-09T00:00:00.000Z",
      entries: [
        catalogEntry({ id: "anthropic/claude-sonnet-5", provider: "openrouter" }),
        catalogEntry({ id: "claude-sonnet-5", provider: "anthropic" }),
      ],
    };

    const rows = decideModelPickerOpen(catalog, new Set(["anthropic"]));
    const openrouterRow = rows.find((row) => row.entry.provider === "openrouter");
    const anthropicRow = rows.find((row) => row.entry.provider === "anthropic");

    expect(openrouterRow?.rerouteTo).toBe("anthropic");
    // A row that already has its own key has nothing to reroute to.
    expect(anthropicRow?.rerouteTo).toBeUndefined();
  });

  test("rerouteTo is undefined when no sibling has a key either — a true dead end, not a guess", () => {
    const catalog: ModelCatalog = {
      fetchedAt: "2026-08-09T00:00:00.000Z",
      entries: [
        catalogEntry({ id: "anthropic/claude-sonnet-5", provider: "openrouter" }),
        catalogEntry({ id: "claude-sonnet-5", provider: "anthropic" }),
      ],
    };

    const rows = decideModelPickerOpen(catalog, new Set());
    const openrouterRow = rows.find((row) => row.entry.provider === "openrouter");

    expect(openrouterRow?.alternatives).toBe(1);
    expect(openrouterRow?.rerouteTo).toBeUndefined();
  });

  // D7 (feature-plan.md): `planCoverage` is an optional, always-false-by-default seam — the one
  // production call site never passes a third argument, so this is the negative control proving
  // that default keeps today's behavior byte-for-byte.
  test("gatewayReachable is false on every row when planCoverage is omitted", () => {
    const catalog: ModelCatalog = {
      fetchedAt: "2026-08-09T00:00:00.000Z",
      entries: [
        catalogEntry({ id: "anthropic/claude-sonnet-5", provider: "openrouter" }),
        catalogEntry({ id: "claude-sonnet-5", provider: "anthropic" }),
      ],
    };

    const rows = decideModelPickerOpen(catalog, new Set(["anthropic"]));
    expect(rows.length).toBe(2);
    expect(rows.every((row) => row.gatewayReachable === false)).toBe(true);
  });

  test("gatewayReachable threads a planCoverage predicate through to each row", () => {
    const catalog: ModelCatalog = {
      fetchedAt: "2026-08-09T00:00:00.000Z",
      entries: [
        catalogEntry({ id: "anthropic/claude-sonnet-5", provider: "openrouter" }),
        catalogEntry({ id: "claude-sonnet-5", provider: "anthropic" }),
      ],
    };

    const rows = decideModelPickerOpen(catalog, new Set(), () => true);
    const openrouterRow = rows.find((row) => row.entry.provider === "openrouter");

    expect(openrouterRow?.keyConfigured).toBe(false);
    expect(openrouterRow?.rerouteTo).toBeUndefined();
    expect(openrouterRow?.gatewayReachable).toBe(true);
  });
});

const ALL_KEY_NAMES = [
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
];
const originalKeyEnv = Object.fromEntries(ALL_KEY_NAMES.map((name) => [name, process.env[name]]));

describe("decideSetupOpen", () => {
  let setupConfigDir: string;

  beforeEach(() => {
    for (const name of ALL_KEY_NAMES) delete process.env[name];
    setupConfigDir = mkdtempSync(join(tmpdir(), "seri-setup-commands-test-"));
  });

  afterEach(() => {
    for (const name of ALL_KEY_NAMES) {
      const original = originalKeyEnv[name];
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
    rmSync(setupConfigDir, { recursive: true, force: true });
  });

  test("returns exactly 5 rows, in CATALOG_PROVIDERS order, all unset by default", () => {
    const rows = decideSetupOpen(setupConfigDir);
    expect(rows.map((row) => row.provider)).toEqual([...CATALOG_PROVIDERS]);
    expect(rows.every((row) => row.source === "unset" && row.masked === undefined)).toBe(true);
    expect(rows.every((row) => row.removable === false)).toBe(true);
  });

  test("a config-file entry is source: config, masked, and removable", () => {
    setConfigValue("ANTHROPIC_API_KEY", "sk-fake-config-key", setupConfigDir);
    const row = decideSetupOpen(setupConfigDir).find((r) => r.provider === "anthropic");
    expect(row?.source).toBe("config");
    expect(row?.masked).toBeDefined();
    expect(row?.removable).toBe(true);
  });

  // D8: an env-sourced row cannot be removed from here — there is no config.json entry to unset.
  test("an env-shadowed row (no config entry) is source: env and NOT removable", () => {
    process.env.ANTHROPIC_API_KEY = "sk-fake-env-key";
    const row = decideSetupOpen(setupConfigDir).find((r) => r.provider === "anthropic");
    expect(row?.source).toBe("env");
    expect(row?.removable).toBe(false);
  });

  // Bug fixed here (code-review, PR #73): an env-shadowed row WITH a config.json entry
  // underneath it IS removable — the config entry is genuinely there to unset, even though env
  // wins for display. The old `removable: source === "config"` was always false in this exact
  // state, making a previously-saved /setup secret permanently unremovable the moment the
  // same-named env var got exported.
  test("an env-shadowed row WITH a config entry underneath is source: env and IS removable", () => {
    setConfigValue("ANTHROPIC_API_KEY", "sk-fake-config-key", setupConfigDir);
    process.env.ANTHROPIC_API_KEY = "sk-fake-env-key";
    const row = decideSetupOpen(setupConfigDir).find((r) => r.provider === "anthropic");
    expect(row?.source).toBe("env");
    expect(row?.removable).toBe(true);
  });
});

describe.skipIf(!isGitAvailable())("decideUndo", () => {
  test("restores the previous file state and reports what changed", () => {
    const snapshot = checkpointer();
    snapshot({
      tool: "write_file",
      toolCallId: "c1",
      args: { path: join(workTree, "a.txt") },
      rewindTo: 1,
    });
    writeFileSync(join(workTree, "a.txt"), "after\n");
    snapshot({
      tool: "write_file",
      toolCallId: "c2",
      args: { path: join(workTree, "a.txt") },
      rewindTo: 2,
    });

    const { next, plan, message } = decideUndo(session(), ["2"], {
      sessionsDir: join(root, "sessions"),
      checkpointsDir,
      configDir: root,
    });

    expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("before\n");
    expect(plan.restored).toEqual(["a.txt"]);
    expect(message).toBe("Undid to checkpoint 2.");
    // The session itself is not mutated by an undo — only the filesystem changes.
    expect(next.messages).toEqual([]);
  }, 30_000);

  test("reports no change when the checkpoint is already the current state", () => {
    checkpointer()({
      tool: "write_file",
      toolCallId: "c1",
      args: { path: join(workTree, "a.txt") },
      rewindTo: 1,
    });

    const { message } = decideUndo(session(), ["1"], {
      sessionsDir: join(root, "sessions"),
      checkpointsDir,
      configDir: root,
    });

    expect(message).toBe("Already at checkpoint 1; no file changed.");
  }, 30_000);

  // M-5 regression: onPlan (undoFiles' own callback) has to fire BEFORE the restore/removal pass
  // mutates the worktree, matching output.ts's own documented guarantee on undoPlanLines ("before
  // the restore happens, not after") — restoring that for the console path is the whole reason
  // decideUndo accepts onPlan at all rather than hardcoding a no-op. Checked here by reading the
  // file's content from INSIDE the callback: at that point the file must still read "after", not
  // yet reverted to "before".
  test("onPlan fires with the plan before the restore mutates the worktree", () => {
    const snapshot = checkpointer();
    snapshot({
      tool: "write_file",
      toolCallId: "c1",
      args: { path: join(workTree, "a.txt") },
      rewindTo: 1,
    });
    writeFileSync(join(workTree, "a.txt"), "after\n");
    snapshot({
      tool: "write_file",
      toolCallId: "c2",
      args: { path: join(workTree, "a.txt") },
      rewindTo: 2,
    });

    const seenDuringOnPlan: string[] = [];
    decideUndo(
      session(),
      ["2"],
      { sessionsDir: join(root, "sessions"), checkpointsDir, configDir: root },
      (plan) => {
        seenDuringOnPlan.push(readFileSync(join(workTree, "a.txt"), "utf8"));
        expect(plan.restored).toEqual(["a.txt"]);
      },
    );

    expect(seenDuringOnPlan).toEqual(["after\n"]);
    expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("before\n");
  }, 30_000);
});

describe.skipIf(!isGitAvailable())("decideRestore", () => {
  test("restores the named commit and reports it", () => {
    const snapshot = checkpointer();
    snapshot({
      tool: "write_file",
      toolCallId: "c1",
      args: { path: join(workTree, "a.txt") },
      rewindTo: 1,
    });
    writeFileSync(join(workTree, "a.txt"), "after\n");
    snapshot({
      tool: "write_file",
      toolCallId: "c2",
      args: { path: join(workTree, "a.txt") },
      rewindTo: 2,
    });

    const records = readLog(storeDir, SESSION).filter(
      (record): record is Extract<CheckpointRecord, { kind: "tool" }> => record.kind === "tool",
    );
    const firstCommit = records[0]?.commit ?? "";

    const { plan, message } = decideRestore(session(), [firstCommit], {
      sessionsDir: join(root, "sessions"),
      checkpointsDir,
      configDir: root,
    });

    expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("before\n");
    expect(plan.restored).toEqual(["a.txt"]);
    expect(message).toBe(`Restored ${firstCommit}.`);
  }, 30_000);
});

describe.skipIf(!isGitAvailable())("decideRewind", () => {
  test("truncates the session's messages, touches no file, and reports what was dropped", () => {
    checkpointer()({
      tool: "write_file",
      toolCallId: "c1",
      args: { path: join(workTree, "a.txt") },
      rewindTo: 1,
    });

    const before = session({
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
      ],
    });

    const { next, message } = decideRewind(before, [], {
      sessionsDir: join(root, "sessions"),
      checkpointsDir,
      configDir: root,
    });

    expect(next.messages).toEqual([{ role: "user", content: "one" }]);
    expect(before.messages).toHaveLength(3);
    expect(message).toBe(
      `Session ${SESSION}: dropped 2 message(s), 1 remain. No file was touched.`,
    );
    expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("before\n");
    expect(existsSync(join(workTree, "a.txt"))).toBe(true);
  }, 30_000);

  // Finding 9 (thermo-nuclear structural review, round 6): decideRewind itself no longer appends
  // the barrier — it hands back a `recordBarrier` closure for the CALLER to call after persisting
  // `next`, restoring the original (pre-TUI) saveSession-then-appendBarrier order. This is the
  // deferred half of that fix: the barrier must not exist in the log until recordBarrier() is
  // actually called, and must exist once it is.
  test("does not record the barrier until recordBarrier() is called", () => {
    checkpointer()({
      tool: "write_file",
      toolCallId: "c1",
      args: { path: join(workTree, "a.txt") },
      rewindTo: 1,
    });
    const before = session({
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
      ],
    });
    const dirs = { sessionsDir: join(root, "sessions"), checkpointsDir, configDir: root };

    const { recordBarrier } = decideRewind(before, [], dirs);

    expect(readLog(storeDir, SESSION).some((r) => r.kind === "rewind-barrier")).toBe(false);
    recordBarrier();
    expect(readLog(storeDir, SESSION).some((r) => r.kind === "rewind-barrier")).toBe(true);
  }, 30_000);
});
