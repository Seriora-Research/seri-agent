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
import { saveAuthSession } from "../../src/auth/authStore";
import {
  type CheckpointRecord,
  checkpointStoreDir,
  createCheckpointer,
  readLog,
} from "../../src/checkpoint/checkpoint";
import { isGitAvailable } from "../../src/checkpoint/shadowGit";
import { setConfigValue } from "../../src/config/config";
import { getBaseConfigDir } from "../../src/config/paths";
import { rememberGrant } from "../../src/permissions/store";
import bundledManifest from "../../src/provider/catalog-manifest.json";
import type { SessionState } from "../../src/session/session";
import {
  decideAuthOffer,
  decideConfigOpen,
  decideGuidedModelPickerOpen,
  decideMaxTurns,
  decideModeCycle,
  decideModelPickerOpen,
  decidePermissionsOpen,
  decideProfileCreate,
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

// byok-guided-setup-default-model bugfix report, Decision 3: the guided-setup picker must never
// offer a row `resolveRoute` cannot actually reach — against the real bundled 350-entry manifest,
// not a hand-built fixture, since the filter's whole point is a guarantee about that exact catalog.
describe("decideGuidedModelPickerOpen", () => {
  const catalog = bundledManifest as ModelCatalog;
  const configured = new Set<ModelProvider>(["anthropic"]);

  test("every returned row has its own key or a working reroute target", () => {
    const rows = decideGuidedModelPickerOpen(catalog, configured);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.keyConfigured || row.rerouteTo !== undefined)).toBe(true);
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
});

describe("decideConfigOpen", () => {
  let configConfigDir: string;
  // All three known keys, not just SERI_WORKOS_CLIENT_ID (code review, round 2): any dev box or
  // CI runner with SERI_VERIFY_ENABLED/SERI_VERIFY_COMMAND genuinely exported would otherwise
  // silently fail the "all three are unset" assertion below.
  const KNOWN_KEYS = ["SERI_WORKOS_CLIENT_ID", "SERI_VERIFY_ENABLED", "SERI_VERIFY_COMMAND"];
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

  test("all three known keys are source: unset on an empty config dir", () => {
    const rows = decideConfigOpen(configConfigDir);
    expect(rows.map((row) => row.key)).toEqual([
      "SERI_WORKOS_CLIENT_ID",
      "SERI_VERIFY_ENABLED",
      "SERI_VERIFY_COMMAND",
    ]);
    expect(rows.every((row) => row.source === "unset" && row.removable === false)).toBe(true);
  });

  // None of the three known keys are secrets (code review, round 2) — SERI_VERIFY_COMMAND might
  // be "bun check", which a user should be able to read back verbatim, not see as asterisks.
  test("a known key written via config.json is source: config, removable, and NOT masked", () => {
    setConfigValue("SERI_VERIFY_COMMAND", "bun run typecheck", configConfigDir);
    const row = decideConfigOpen(configConfigDir).find((r) => r.key === "SERI_VERIFY_COMMAND");
    expect(row?.source).toBe("config");
    expect(row?.removable).toBe(true);
    expect(row?.secret).toBe(false);
    expect(row?.masked).toBe("bun run typecheck");
  });

  // An unrecognized key defaults to secret: true (conservative) and is genuinely masked.
  test("an unknown key written via config.json is secret: true and masked, not the raw value", () => {
    setConfigValue("SERI_SOME_OTHER_KEY", "sk-fake-secret-value", configConfigDir);
    const row = decideConfigOpen(configConfigDir).find((r) => r.key === "SERI_SOME_OTHER_KEY");
    expect(row?.secret).toBe(true);
    expect(row?.masked).not.toBe("");
    expect(row?.masked).not.toBe("sk-fake-secret-value");
  });

  test("a key set via env var is source: env", () => {
    process.env.SERI_WORKOS_CLIENT_ID = "client-from-env";
    const row = decideConfigOpen(configConfigDir).find((r) => r.key === "SERI_WORKOS_CLIENT_ID");
    expect(row?.source).toBe("env");
  });

  // Code review, round 2: `source`/value used to disagree on an env var set to "" — `source`
  // read `!== undefined` (true for ""), the value read `||` (falls through to config.json for the
  // falsy ""). Both must now agree: env wins for `source` AND for the value read.
  test("an env var set to the empty string is source: env, not source: config", () => {
    setConfigValue("SERI_VERIFY_COMMAND", "bun run typecheck", configConfigDir);
    process.env.SERI_VERIFY_COMMAND = "";
    const row = decideConfigOpen(configConfigDir).find((r) => r.key === "SERI_VERIFY_COMMAND");
    expect(row?.source).toBe("env");
    expect(row?.masked).toBe("");
  });

  test("a provider API key written to config.json is absent from the returned rows", () => {
    setConfigValue("GROQ_API_KEY", "sk-fake-groq-key", configConfigDir);
    const rows = decideConfigOpen(configConfigDir);
    expect(rows.some((row) => row.key === "GROQ_API_KEY")).toBe(false);
  });

  test("a non-provider hand-added key in config.json is present", () => {
    setConfigValue("SERI_SOME_OTHER_KEY", "value", configConfigDir);
    const rows = decideConfigOpen(configConfigDir);
    expect(rows.some((row) => row.key === "SERI_SOME_OTHER_KEY")).toBe(true);
  });
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

describe("decideProfileCreate", () => {
  test("returns the absolute profile directory path, without creating it", () => {
    const path = decideProfileCreate(["new", "work"]);
    expect(path).toBe(join(getBaseConfigDir(), "work"));
    expect(existsSync(path)).toBe(false);
  });

  test("throws on a path-traversal name", () => {
    expect(() => decideProfileCreate(["new", "../etc"])).toThrow();
  });

  // "sessions" collides with the sessions/ directory every profile root already has
  // (config/paths.ts's getReservedProfileNames).
  test("throws on a reserved name", () => {
    expect(() => decideProfileCreate(["new", "sessions"])).toThrow();
  });
});
