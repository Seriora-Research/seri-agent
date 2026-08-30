import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CATALOG_PROVIDERS,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelProvider,
} from "@seri/model-catalog";
import type { ModelMessage } from "ai";
import { loadAgentsFile } from "../../src/agents/loadAgentsFile";
import { buildSystemPrompt } from "../../src/agents/systemPrompt";
import { saveAuthSession } from "../../src/auth/authStore";
import {
  type CheckpointRecord,
  checkpointStoreDir,
  createCheckpointer,
  readLog,
} from "../../src/checkpoint/checkpoint";
import { isGitAvailable } from "../../src/checkpoint/shadowGit";
import { loadVerifyConfig, setConfigValue, unsetConfigValue } from "../../src/config/config";
import { getBaseConfigDir } from "../../src/config/paths";
import { rememberGrant } from "../../src/permissions/store";
import bundledManifest from "../../src/provider/catalog-manifest.json";
import type { SessionState } from "../../src/session/session";
import {
  configKeyInfo,
  decideAuthOffer,
  decideClear,
  decideConfigOpen,
  decideEffortOpen,
  decideGuidedModelPickerOpen,
  decideMaxTurns,
  decideModeCycle,
  decideModelPickerOpen,
  decidePermissionsOpen,
  decideProfileCreate,
  decideRestore,
  decideRewind,
  decideSetupOpen,
  decideTrajectoryCommand,
  decideUndo,
  KNOWN_CONFIG_KEYS,
} from "../../src/tui/state/commands";

let root: string;
let storeDir: string;
let workTree: string;
let checkpointsDir: string;
let configDir: string;

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
  configDir = join(root, "profile");
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

  // `planCoverage` is an optional, always-false-by-default seam — a caller that passes nothing
  // gets today's behavior byte-for-byte, the negative control this proves.
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

    const rows = decideModelPickerOpen(
      catalog,
      new Set(),
      (entry) => entry.provider === "openrouter",
    );
    const openrouterRow = rows.find((row) => row.entry.provider === "openrouter");
    const anthropicRow = rows.find((row) => row.entry.provider === "anthropic");

    expect(openrouterRow?.keyConfigured).toBe(false);
    expect(openrouterRow?.rerouteTo).toBeUndefined();
    expect(openrouterRow?.gatewayReachable).toBe(true);
    expect(anthropicRow?.gatewayReachable).toBe(false);
  });
});

// byok-guided-setup-default-model bugfix report, Decision 3: the guided-setup picker must never
// offer a row `resolveRoute` cannot actually reach — against the real bundled 350-entry manifest,
// not a hand-built fixture, since the filter's whole point is a guarantee about that exact catalog.
describe("decideGuidedModelPickerOpen", () => {
  const catalog = bundledManifest as ModelCatalog;
  const configured = new Set<ModelProvider>(["anthropic"]);

  // The important regression test for the keyless-row-removal fix: a keyless row's model/provider
  // pair is only reachable in the guided picker's own live+fallback merge, never guaranteed
  // reachable in the LIVE catalog `resolveRoute` re-checks against at actual routing time — so
  // every row must carry its own key, and no row may carry a `rerouteTo` at all. RED against the
  // pre-fix code (the `keyed`/`rerouted` partition): that code allowed a keyless row through
  // whenever `rerouteTo` was set, which this assertion would have caught immediately.
  test("every returned row has keyConfigured true, and no row has a rerouteTo", () => {
    const rows = decideGuidedModelPickerOpen(catalog, configured);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.keyConfigured === true)).toBe(true);
    expect(rows.every((row) => row.rerouteTo === undefined)).toBe(true);
  });

  test("contains native anthropic rows — the key that was actually configured", () => {
    const rows = decideGuidedModelPickerOpen(catalog, configured);
    expect(rows.some((row) => row.entry.provider === "anthropic")).toBe(true);
  });

  test("is a strict subset of decideModelPickerOpen's output for the same inputs", () => {
    const all = decideModelPickerOpen(catalog, configured);
    const guided = decideGuidedModelPickerOpen(catalog, configured);
    const allKeys = new Set(all.map((row) => `${row.entry.provider}/${row.entry.id}`));
    expect(guided.length).toBeLessThan(all.length);
    expect(guided.every((row) => allKeys.has(`${row.entry.provider}/${row.entry.id}`))).toBe(true);
  });

  // Reviewer-verifier finding M1: this function's own guarantee was measured against the bundled
  // manifest (every provider has entries there), but its real production input is the LIVE
  // models.dev payload — `loadCatalog` silently drops any provider missing/malformed in that
  // response, so a catalog with zero entries for the configured provider is a reachable input, not
  // a theoretical one. `onSetupClose` (cli.ts) guards against exactly this — an empty result must
  // degrade to the decline path rather than open a picker with nothing to select — this test proves
  // the input that guard exists for is real.
  test("returns [] when the catalog has no entries at all for the configured provider", () => {
    const catalog: ModelCatalog = {
      fetchedAt: "2026-08-09T00:00:00.000Z",
      entries: [catalogEntry({ id: "a", provider: "groq" })],
    };
    expect(decideGuidedModelPickerOpen(catalog, new Set(["anthropic"]))).toEqual([]);
  });

  // byRoutePriority (routing.ts) orders a route group's members native-then-aggregator, ties
  // broken by CATALOG_PROVIDERS order — groq before openrouter, regardless of which one the user
  // actually has a key for. Under the old keyed/rerouted partition, the keyless groq row would
  // have sorted first within the group and then been pushed after the keyed openrouter row; now
  // it must not appear at all. RED against the pre-fix code: the old partition returned the groq
  // row (with `rerouteTo: "openrouter"`) as `rows[1]`, so `rows.length` was 2, not 1.
  test("never includes a keyless row, even when one would sort first", () => {
    const routeCatalog: ModelCatalog = {
      fetchedAt: "2026-08-09T00:00:00.000Z",
      entries: [
        catalogEntry({ id: "openai/gpt-oss-120b", provider: "groq" }),
        catalogEntry({ id: "openai/gpt-oss-120b", provider: "openrouter" }),
      ],
    };
    const rows = decideGuidedModelPickerOpen(routeCatalog, new Set(["openrouter"]));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entry.provider).toBe("openrouter");
  });

  // code-review finding: `alternatives` (decideModelPickerOpen's own group.length - 1) is computed
  // over the FULL route group before the keyless-row filter above drops every unshown sibling — a
  // surviving row must not keep claiming an "alternative" that this list no longer contains. RED
  // against the pre-fix code: `alternatives` stayed 1 (the full group's count) even after the
  // groq sibling was filtered out, so formatModelRow would render "+1 route" for a route this list
  // never shows.
  test("recomputes alternatives from the filtered rows, not the stale full-group count", () => {
    const routeCatalog: ModelCatalog = {
      fetchedAt: "2026-08-09T00:00:00.000Z",
      entries: [
        catalogEntry({ id: "openai/gpt-oss-120b", provider: "groq" }),
        catalogEntry({ id: "openai/gpt-oss-120b", provider: "openrouter" }),
      ],
    };
    const rows = decideGuidedModelPickerOpen(routeCatalog, new Set(["openrouter"]));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.alternatives).toBe(0);
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

// /effort's own decide/handlers pairing, following
// decideSetupOpen's exact fixture shape just above (env clearing via the shared ALL_KEY_NAMES,
// its own fresh configDir).
describe("decideEffortOpen", () => {
  let effortConfigDir: string;
  // `ALL_KEY_NAMES` above is provider API keys only — `decideEffortOpen`
  // also reads SERI_REASONING_EFFORT (via resolveReasoningEffort's own config fallback), so a dev
  // box or CI runner with that genuinely exported would silently select the wrong `selected` index
  // in "returns the legal tiers and defaults selected to 0 with no current override" below (a
  // real env value competing with the session's own deliberate absence of one). Own save/clear/
  // restore, matching decideConfigOpen's own KNOWN_KEYS pattern below for the identical hazard.
  const originalReasoningEffortEnv = process.env.SERI_REASONING_EFFORT;

  beforeEach(() => {
    for (const name of ALL_KEY_NAMES) delete process.env[name];
    delete process.env.SERI_REASONING_EFFORT;
    effortConfigDir = mkdtempSync(join(tmpdir(), "seri-effort-commands-test-"));
  });

  afterEach(() => {
    for (const name of ALL_KEY_NAMES) {
      const original = originalKeyEnv[name];
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
    if (originalReasoningEffortEnv === undefined) delete process.env.SERI_REASONING_EFFORT;
    else process.env.SERI_REASONING_EFFORT = originalReasoningEffortEnv;
    rmSync(effortConfigDir, { recursive: true, force: true });
  });

  const catalog: ModelCatalog = {
    fetchedAt: "2026-08-25T00:00:00.000Z",
    entries: [
      catalogEntry({
        id: "reasoning-model",
        provider: "groq",
        reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }],
      }),
      catalogEntry({ id: "plain-model", provider: "groq" }),
    ],
  };

  test("returns the legal tiers and defaults selected to 0 with no current override", () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const result = decideEffortOpen(
      catalog,
      effortConfigDir,
      session({ model: "reasoning-model", provider: "groq" }),
      null,
    );

    expect(result).toEqual({ tiers: ["low", "medium", "high"], selected: 0 });
  });

  test("opens with the session's own current override already highlighted", () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const result = decideEffortOpen(
      catalog,
      effortConfigDir,
      session({ model: "reasoning-model", provider: "groq", reasoningEffort: "high" }),
      null,
    );

    expect(result).toEqual({ tiers: ["low", "medium", "high"], selected: 2 });
  });

  test("returns null when the resolved model has no reasoning-effort tiers at all", () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const result = decideEffortOpen(
      catalog,
      effortConfigDir,
      session({ model: "plain-model", provider: "groq" }),
      null,
    );

    expect(result).toBeNull();
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

  // The message must not claim "no file changed" when a candidate WAS identified for deletion but
  // held back because the write ledger has no proof seri wrote it (writeLedger.ts's own
  // filterSafeToDelete) — restored/deleted both empty is not the same thing as an empty plan.
  test("reports preserved files instead of claiming no change when a candidate was held back", () => {
    const snapshot = checkpointer();
    snapshot({
      tool: "write_file",
      toolCallId: "c1",
      args: { path: join(workTree, "a.txt") },
      rewindTo: 1,
    });
    // Written directly, bypassing the checkpointer's onAfterMutation — no ledger entry, so a
    // restore back past this point cannot prove seri wrote it.
    writeFileSync(join(workTree, "b.txt"), "created outside write_file\n");
    snapshot({
      tool: "write_file",
      toolCallId: "c2",
      args: { path: join(workTree, "a.txt") },
      rewindTo: 2,
    });

    const { plan, message } = decideUndo(session(), ["2"], {
      sessionsDir: join(root, "sessions"),
      checkpointsDir,
      configDir: root,
    });

    expect(plan.restored).toEqual([]);
    expect(plan.deleted).toEqual([]);
    expect(plan.preserved).toEqual(["b.txt"]);
    expect(message).toBe(
      "Already at checkpoint 2; no file restored or deleted, but 1 file(s) preserved (no proof seri wrote them, or edited since).",
    );
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

// Unlike decideRewind, decideClear touches no checkpoint store — no git repo needed, so this is
// not skipIf(!isGitAvailable()).
describe("decideClear", () => {
  test("mints a new id and empties messages", () => {
    const before = session({ messages: [{ role: "user", content: "hi" }] });

    const { next } = decideClear(before, configDir, "new-id");
    expect(next.id).toBe("new-id");
    expect(next.messages).toEqual([]);

    // No second arg: still mints a fresh, distinct id.
    const { next: auto } = decideClear(before, configDir);
    expect(auto.id).not.toBe(before.id);
    expect(typeof auto.id).toBe("string");
    expect(auto.id.length).toBeGreaterThan(0);
  });

  test("carries every other header field over verbatim", () => {
    const before = session({
      cwd: "/some/distinctive/path",
      permissionMode: "auto",
      model: "gpt-5",
      provider: "openai",
      messages: [{ role: "user", content: "hi" }],
    });

    const { next } = decideClear(before, configDir, "new-id");

    expect(next.cwd).toBe(before.cwd);
    expect(next.permissionMode).toBe(before.permissionMode);
    expect(next.model).toBe(before.model);
    expect(next.provider).toBe(before.provider);
  });

  // Unlike every other header field above, systemPrompt is NOT carried over — decideClear's own
  // comment explains why (loadOrCreateSession's new-session and resume paths never replay a stored
  // one either, so an AGENTS.md edited since the session started must be picked up here too).
  test("rebuilds systemPrompt from cwd's AGENTS.md instead of carrying the old one over", () => {
    writeFileSync(join(workTree, "AGENTS.md"), "distinctive project instructions");
    const before = session({ systemPrompt: "stale prompt from before the edit" });

    const { next } = decideClear(before, configDir, "new-id");

    expect(next.systemPrompt).toBe(
      buildSystemPrompt({ agentsContent: loadAgentsFile(workTree), skills: [], rules: [] }),
    );
    expect(next.systemPrompt).not.toBe(before.systemPrompt);
  });

  test("honours an injected loadAgents override instead of always reading the real filesystem", () => {
    const before = session({ systemPrompt: "stale" });
    const stub = (cwd: string) => `stubbed content for ${cwd}`;

    const { next } = decideClear(before, configDir, "new-id", stub);

    expect(next.systemPrompt).toBe(
      buildSystemPrompt({ agentsContent: stub(workTree), skills: [], rules: [] }),
    );
  });

  test("does not mutate the session it was given", () => {
    const before = session({ messages: [{ role: "user", content: "hi" }] });

    decideClear(before, configDir, "new-id");

    expect(before.messages).toHaveLength(1);
    expect(before.id).toBe(SESSION);
  });

  test("the message names both ids and points at seri --resume", () => {
    const before = session({ messages: [] });

    const { message } = decideClear(before, configDir, "new-id");

    expect(message).toContain("new-id");
    expect(message).toContain(SESSION);
    expect(message).toContain("--resume");
  });

  test("does not persist or print", () => {
    const sessionsDir = join(root, "sessions");
    const before = session({ messages: [{ role: "user", content: "hi" }] });

    decideClear(before, configDir, "new-id");

    expect(existsSync(sessionsDir)).toBe(false);
  });
});

// Stage A scaffolding (cli-commands-to-tui feature-plan.md): these five decide* functions have no
// caller yet — Stages B-E wire /login, /signup, /config, /permissions, /max-turns and /profile new
// to them.
describe("decideAuthOffer", () => {
  let authConfigDir: string;

  beforeEach(() => {
    authConfigDir = mkdtempSync(join(tmpdir(), "seri-auth-offer-test-"));
  });

  afterEach(() => {
    rmSync(authConfigDir, { recursive: true, force: true });
  });

  test("true when no auth session is saved", () => {
    expect(decideAuthOffer(authConfigDir)).toBe(true);
  });

  test("false once an auth session is saved", () => {
    saveAuthSession(
      {
        accessToken: "at-1",
        refreshToken: "rt-1",
        userId: "user_1",
        email: "a@example.com",
        obtainedAt: "2026-08-13T00:00:00.000Z",
      },
      authConfigDir,
    );

    expect(decideAuthOffer(authConfigDir)).toBe(false);
  });

  // Thermo-nuclear review + code-review, PR #94 (root-cause round): decideAuthOffer no longer
  // throws on a corrupted auth.json — loadAuthSession (authStore.ts) itself now degrades a
  // read/parse failure to `undefined`, the same "not authenticated" state as no file at all,
  // fixing this at the one place that reads the file rather than every caller needing its own
  // try/catch (the earlier version of this test asserted the opposite: that this threw, which is
  // exactly the "wrap every call site" pattern this fix replaces). Mirrors the pty suite's own
  // malformed-config convention (tuiPty.test.ts: `writeFileSync(configPath, "{not valid json")`).
  test("returns true (not-authenticated) on a corrupted auth.json, rather than throwing", () => {
    writeFileSync(join(authConfigDir, "auth.json"), "{not valid json");

    expect(decideAuthOffer(authConfigDir)).toBe(true);
  });
});

describe("decideConfigOpen", () => {
  let configConfigDir: string;
  // Env hygiene for every key this describe block touches, not just the three displayed ones: any
  // dev box or CI runner with SERI_VERIFY_ENABLED/SERI_VERIFY_COMMAND/SERI_REASONING_EFFORT
  // genuinely exported would otherwise silently fail the "all are unset" assertion below, and
  // SERI_WORKOS_CLIENT_ID is set directly by this file's own exclusion test further down.
  const KNOWN_KEYS = [
    "SERI_WORKOS_CLIENT_ID",
    "SERI_VERIFY_ENABLED",
    "SERI_VERIFY_COMMAND",
    "SERI_REASONING_EFFORT",
  ];
  const originalEnv = Object.fromEntries(KNOWN_KEYS.map((name) => [name, process.env[name]]));

  beforeEach(() => {
    for (const name of KNOWN_KEYS) delete process.env[name];
    configConfigDir = mkdtempSync(join(tmpdir(), "seri-config-open-test-"));
  });

  afterEach(() => {
    rmSync(configConfigDir, { recursive: true, force: true });
    // Teardown must `delete`, never reassign `undefined` — Bun/Node coerce
    // `process.env.X = undefined` to the literal string "undefined" (code-quality.md's own
    // cross-platform env-var lesson).
    for (const name of KNOWN_KEYS) {
      const original = originalEnv[name];
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  });

  test("all known keys are source: unset on an empty config dir", () => {
    const rows = decideConfigOpen(configConfigDir);
    expect(rows.map((row) => row.key)).toEqual([
      "SERI_VERIFY_ENABLED",
      "SERI_VERIFY_COMMAND",
      "SERI_REASONING_EFFORT",
    ]);
    expect(rows.every((row) => row.source === "unset" && row.removable === false)).toBe(true);
  });

  // Neither of the two known keys is a secret — SERI_VERIFY_COMMAND might be "bun check", which
  // a user should be able to read back verbatim, not see as asterisks.
  test("a known key written via config.json is source: config, removable, and NOT masked", () => {
    setConfigValue("SERI_VERIFY_COMMAND", "bun run typecheck", configConfigDir);
    const row = decideConfigOpen(configConfigDir).find((r) => r.key === "SERI_VERIFY_COMMAND");
    expect(row?.source).toBe("config");
    expect(row?.removable).toBe(true);
    expect(row?.masked).toBe("bun run typecheck");
  });

  // An unrecognized key defaults to secret (conservative) and is genuinely masked — `secret`
  // itself isn't on ConfigRow (it's a pure function of `key`, local to decideConfigOpen), so this
  // asserts the one thing it's observable through: `masked` never being the raw value.
  test("an unknown key written via config.json is masked, not the raw value", () => {
    setConfigValue("SERI_SOME_OTHER_KEY", "sk-fake-secret-value", configConfigDir);
    const row = decideConfigOpen(configConfigDir).find((r) => r.key === "SERI_SOME_OTHER_KEY");
    expect(row?.masked).not.toBe("");
    expect(row?.masked).not.toBe("sk-fake-secret-value");
  });

  test("a key set via env var is source: env", () => {
    process.env.SERI_VERIFY_ENABLED = "1";
    const row = decideConfigOpen(configConfigDir).find((r) => r.key === "SERI_VERIFY_ENABLED");
    expect(row?.source).toBe("env");
  });

  // An empty-string env var must not outrank config.json: it loses the precedence race (same
  // falsy-skip rule as loadVerifyConfig's own live default resolution), so both `source` and
  // `masked` must say "config", not silently display a value the running session doesn't read.
  test("an env var set to the empty string falls through to config.json for source and value", () => {
    setConfigValue("SERI_VERIFY_COMMAND", "bun run typecheck", configConfigDir);
    process.env.SERI_VERIFY_COMMAND = "";
    const row = decideConfigOpen(configConfigDir).find((r) => r.key === "SERI_VERIFY_COMMAND");
    expect(row?.source).toBe("config");
    expect(row?.masked).toBe("bun run typecheck");
  });

  test("a provider API key written to config.json is absent from the returned rows", () => {
    setConfigValue("GROQ_API_KEY", "sk-fake-groq-key", configConfigDir);
    const rows = decideConfigOpen(configConfigDir);
    expect(rows.some((row) => row.key === "GROQ_API_KEY")).toBe(false);
  });

  test("SERI_WORKOS_CLIENT_ID is absent from the returned rows even when set via config.json or env", () => {
    setConfigValue("SERI_WORKOS_CLIENT_ID", "client_from_config", configConfigDir);
    expect(
      decideConfigOpen(configConfigDir).some((row) => row.key === "SERI_WORKOS_CLIENT_ID"),
    ).toBe(false);

    // Unset the config.json entry first — otherwise this second assertion would pass even if the
    // env-only path were broken, since the config.json exclusion above already covers the key.
    unsetConfigValue("SERI_WORKOS_CLIENT_ID", configConfigDir);
    process.env.SERI_WORKOS_CLIENT_ID = "client_from_env";
    expect(
      decideConfigOpen(configConfigDir).some((row) => row.key === "SERI_WORKOS_CLIENT_ID"),
    ).toBe(false);
  });

  test("a non-provider hand-added key in config.json is present", () => {
    setConfigValue("SERI_SOME_OTHER_KEY", "value", configConfigDir);
    const rows = decideConfigOpen(configConfigDir);
    expect(rows.some((row) => row.key === "SERI_SOME_OTHER_KEY")).toBe(true);
  });

  // Both known keys have a real label (CONFIG_KEY_INFO), unlike a hand-added key, whose label
  // falls back to its own raw key (the "unknown key" test just below). This asserts configKeyInfo
  // directly, not through decideConfigOpen — that decideConfigOpen actually emits both known keys,
  // in this order, is what "both known keys are source: unset on an empty config dir" (above)
  // already pins; asserting it again here would just duplicate that coverage.
  test("both known keys get a label that is not their raw key, and a non-empty description", () => {
    for (const key of KNOWN_CONFIG_KEYS) {
      expect(configKeyInfo(key).label).not.toBe(key);
      expect(configKeyInfo(key).description).not.toBe("");
    }
  });

  // Regression guard (found by review): ConfigPanel's `selectedDescription` (panels/
  // ConfigPanel.tsx) renders this in a SINGLE row — PANEL_CHROME_ROWS (format.ts) budgets the
  // panel's whole layout on that assumption, with no wrap allowance. At an 80-column terminal (the
  // repo's own DEFAULT_COLUMNS fallback), the bordered panel's interior is ~78 columns, so a
  // description at or past that wraps to 2 rows and pushes the panel 1 row past its budget — this
  // is exactly what SERI_VERIFY_COMMAND's own description did (81 chars) before being shortened.
  test("no known config key's description is long enough to wrap ConfigPanel's single-row budget", () => {
    for (const key of KNOWN_CONFIG_KEYS) {
      expect(configKeyInfo(key).description.length).toBeLessThanOrEqual(78);
    }
  });

  test("an unknown key falls back to label === key, description === '', kind === 'string'", () => {
    setConfigValue("SERI_SOME_OTHER_KEY", "value", configConfigDir);
    const row = decideConfigOpen(configConfigDir).find((r) => r.key === "SERI_SOME_OTHER_KEY");
    expect(row && configKeyInfo(row.key).label).toBe("SERI_SOME_OTHER_KEY");
    expect(row && configKeyInfo(row.key).description).toBe("");
    expect(row?.kind).toBe("string");
  });

  test("SERI_VERIFY_ENABLED is kind: boolean; SERI_VERIFY_COMMAND is kind: string", () => {
    const rows = decideConfigOpen(configConfigDir);
    expect(rows.find((r) => r.key === "SERI_VERIFY_ENABLED")?.kind).toBe("boolean");
    expect(rows.find((r) => r.key === "SERI_VERIFY_COMMAND")?.kind).toBe("string");
  });

  // Already covered generically by the two KNOWN_CONFIG_KEYS loops above (real label, non-empty
  // description, description length) — this asserts the same facts by name for SERI_REASONING_EFFORT
  // specifically, matching this describe block's existing per-key convention just above/below.
  test("SERI_REASONING_EFFORT has a real label, non-empty description, and kind: string", () => {
    expect(configKeyInfo("SERI_REASONING_EFFORT").label).not.toBe("SERI_REASONING_EFFORT");
    expect(configKeyInfo("SERI_REASONING_EFFORT").description).not.toBe("");
    expect(configKeyInfo("SERI_REASONING_EFFORT").description.length).toBeLessThanOrEqual(78);
    expect(
      decideConfigOpen(configConfigDir).find((r) => r.key === "SERI_REASONING_EFFORT")?.kind,
    ).toBe("string");
  });

  test("SERI_VERIFY_ENABLED's on matrix: unset/'true'/'yes' → true; 'false' → false", () => {
    const on = (): boolean | undefined => {
      const row = decideConfigOpen(configConfigDir).find((r) => r.key === "SERI_VERIFY_ENABLED");
      return row?.kind === "boolean" ? row.on : undefined;
    };
    expect(on()).toBe(true);

    setConfigValue("SERI_VERIFY_ENABLED", "false", configConfigDir);
    expect(on()).toBe(false);

    setConfigValue("SERI_VERIFY_ENABLED", "true", configConfigDir);
    expect(on()).toBe(true);

    // A mistyped value must not silently disable the feature.
    setConfigValue("SERI_VERIFY_ENABLED", "yes", configConfigDir);
    expect(on()).toBe(true);
  });

  test("SERI_VERIFY_ENABLED='false' via env is on: false, source: env", () => {
    process.env.SERI_VERIFY_ENABLED = "false";
    const row = decideConfigOpen(configConfigDir).find((r) => r.key === "SERI_VERIFY_ENABLED");
    expect(row?.source).toBe("env");
    expect(row?.kind === "boolean" && row.on).toBe(false);
  });

  // Anti-drift: decideConfigOpen's own `!== "false"` (this file's own comment on the source, not
  // copied here) must keep agreeing with loadVerifyConfig's (config/config.ts) live default
  // resolution across the same value matrix, without touching config.ts to prove it.
  test("agrees with loadVerifyConfig(dir).enabled across [absent, 'false', 'true', 'yes']", () => {
    const on = (): boolean | undefined => {
      const row = decideConfigOpen(configConfigDir).find((r) => r.key === "SERI_VERIFY_ENABLED");
      return row?.kind === "boolean" ? row.on : undefined;
    };
    expect(on()).toBe(loadVerifyConfig(configConfigDir).enabled);

    for (const value of ["false", "true", "yes"]) {
      setConfigValue("SERI_VERIFY_ENABLED", value, configConfigDir);
      expect(on()).toBe(loadVerifyConfig(configConfigDir).enabled);
    }
  });

  // Same falls-through rule as the string-key test above, exercised on the boolean key: `source`
  // AND `on` both agree with loadVerifyConfig's own live default resolution for env="".
  test("SERI_VERIFY_ENABLED='' in env with a config.json fallback agrees with loadVerifyConfig", () => {
    setConfigValue("SERI_VERIFY_ENABLED", "false", configConfigDir);
    process.env.SERI_VERIFY_ENABLED = "";
    const row = decideConfigOpen(configConfigDir).find((r) => r.key === "SERI_VERIFY_ENABLED");
    expect(row?.source).toBe("config");
    expect(row?.kind === "boolean" && row.on).toBe(loadVerifyConfig(configConfigDir).enabled);
    expect(row?.kind === "boolean" && row.on).toBe(false);
  });

  // Regression test for a masking bypass: a plain object literal used as a lookup table inherits
  // Object.prototype, so a config.json key that happens to share a name with an inherited member
  // (e.g. "toString") would resolve to it instead of falling through to the unknown-key default —
  // the local `secret` inside decideConfigOpen would read false (the inherited member isn't
  // undefined) and render the raw value. CONFIG_KEY_INFO is a Map specifically so this can't
  // happen by construction, not by a guard.
  test.each(["toString", "constructor", "valueOf", "hasOwnProperty", "isPrototypeOf"])(
    "a config key named %s is not treated as a known key and stays masked",
    (key) => {
      setConfigValue(key, "sk-should-not-leak", configConfigDir);
      const row = decideConfigOpen(configConfigDir).find((r) => r.key === key);
      expect(row?.masked).not.toBe("sk-should-not-leak");
      expect(row?.kind).toBe("string");
      expect(row && configKeyInfo(row.key).label).toBe(key);
    },
  );
});

describe("decidePermissionsOpen", () => {
  let permissionsConfigDir: string;
  let permissionsWorktree: string;

  beforeEach(() => {
    permissionsConfigDir = mkdtempSync(join(tmpdir(), "seri-permissions-open-test-"));
    permissionsWorktree = mkdtempSync(join(tmpdir(), "seri-permissions-worktree-test-"));
  });

  afterEach(() => {
    rmSync(permissionsConfigDir, { recursive: true, force: true });
    rmSync(permissionsWorktree, { recursive: true, force: true });
  });

  test("[] on an empty permissions dir", () => {
    expect(decidePermissionsOpen(permissionsConfigDir, permissionsWorktree)).toEqual([]);
  });

  test("a project-tier grant (rememberGrant) is source: persisted, removable", () => {
    rememberGrant(permissionsConfigDir, permissionsWorktree, "write_file");

    expect(decidePermissionsOpen(permissionsConfigDir, permissionsWorktree)).toEqual([
      { tool: "write_file", source: "persisted", removable: true },
    ]);
  });

  // rememberGrant only ever writes to the `projects` tier — a `global` entry (approved for every
  // project) is written directly here to stand in for one a user promoted by hand, per that
  // tier's own documented "seri never writes here" contract (permissions/store.ts's TEMPLATE).
  test("a global-tier grant is source: pre-approved, not removable", () => {
    writeFileSync(
      join(permissionsConfigDir, "permissions.yaml"),
      "global: [write_file]\nprojects: {}\n",
    );

    expect(decidePermissionsOpen(permissionsConfigDir, permissionsWorktree)).toEqual([
      { tool: "write_file", source: "pre-approved", removable: false },
    ]);
  });

  // /code-review, round 3: loadGrants never throws on a malformed store — it degrades to []
  // and reports through onWarning instead, unlike decideConfigOpen's loadConfig (which does
  // throw). decidePermissionsOpen used to drop that callback entirely, so a corrupted
  // permissions.yaml silently rendered as "nothing approved" with no way to tell the two apart.
  // This pins that decidePermissionsOpen actually forwards onWarning to loadGrants, not just
  // that loadGrants itself does (permissions/store.test.ts already covers that half).
  test("a malformed store degrades to [] and reports through onWarning", () => {
    writeFileSync(join(permissionsConfigDir, "permissions.yaml"), ":::not yaml:::");

    const warnings: string[] = [];
    expect(
      decidePermissionsOpen(permissionsConfigDir, permissionsWorktree, (m) => warnings.push(m)),
    ).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});

describe("decideMaxTurns", () => {
  test("a valid positive integer string returns the parsed number", () => {
    expect(decideMaxTurns(["3"])).toBe(3);
  });

  test("throws on zero, non-numeric, missing, or extra arguments", () => {
    expect(() => decideMaxTurns(["0"])).toThrow();
    expect(() => decideMaxTurns(["abc"])).toThrow();
    expect(() => decideMaxTurns([])).toThrow();
    expect(() => decideMaxTurns(["1", "2"])).toThrow();
  });
});

describe("decideTrajectoryCommand", () => {
  test("bare invocation reports the current state and does not request a change", () => {
    expect(decideTrajectoryCommand([], true)).toEqual({
      message: "Trajectory recording is on.",
    });
    expect(decideTrajectoryCommand([], false)).toEqual({
      message: "Trajectory recording is off.",
    });
  });

  test("on and off return the requested enabled flag", () => {
    expect(decideTrajectoryCommand(["off"], true)).toEqual({
      enabled: false,
      message: "Trajectory recording is off.",
    });
    expect(decideTrajectoryCommand(["on"], false)).toEqual({
      enabled: true,
      message: "Trajectory recording is on.",
    });
  });

  test("throws on extra or unknown arguments", () => {
    expect(() => decideTrajectoryCommand(["off", "please"], true)).toThrow();
    expect(() => decideTrajectoryCommand(["maybe"], true)).toThrow();
  });
});

describe("decideProfileCreate", () => {
  test("returns the absolute profile directory path and the validated name, without creating it", () => {
    const { dir, name } = decideProfileCreate(["new", "work"]);
    expect(dir).toBe(join(getBaseConfigDir(), "work"));
    expect(name).toBe("work");
    expect(existsSync(dir)).toBe(false);
  });

  test("throws on a path-traversal name", () => {
    expect(() => decideProfileCreate(["new", "../etc"])).toThrow();
  });

  // "sessions" collides with the sessions/ directory every profile root already has
  // (config/paths.ts's getReservedProfileNames).
  test("throws on a reserved name", () => {
    expect(() => decideProfileCreate(["new", "sessions"])).toThrow();
  });

  // Regression test (thermo-nuclear + code-review, rounds 2-3): "default" isn't rejected by
  // profileNameError (it's absent from getReservedProfileNames), but getConfigDir() folds it onto
  // the base root with no `default/` segment — so the ORIGINAL `join(getBaseConfigDir(), name)`
  // resolution created a directory `--profile default` could never select. Folding "default" the
  // same way (round 2's first fix) stopped the orphaned directory but left `/profile new default`
  // a confusing no-op; rejecting it outright (round 3) is what makes the one profile name that can
  // never be "created" say so.
  test("throws on 'default' — it is already the default profile", () => {
    expect(() => decideProfileCreate(["new", "default"])).toThrow();
  });
});
