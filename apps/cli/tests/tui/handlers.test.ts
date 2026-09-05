import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAuthSession } from "../../src/auth/authStore";
import { CODEX_IGNORE_FILENAME, ignoreCodexSubscription } from "../../src/auth/codexIgnore";
import { needsGuidedSetup } from "../../src/cli";
import { setConfigValue } from "../../src/config/config";
import {
  createConfigHandlers,
  createEffortHandlers,
  createPermissionsHandlers,
  createSetupHandlers,
} from "../../src/tui/state/handlers";
import type { TuiAction } from "../../src/tui/state/reducer";

function actionsCollector(): { actions: TuiAction[]; dispatch: (action: TuiAction) => void } {
  const actions: TuiAction[] = [];
  return {
    actions,
    dispatch: (action) => {
      actions.push(action);
    },
  };
}

describe("dispatchSetupList (via onSetupBack)", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "seri-tui-handlers-test-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  test("a valid config.json refreshes the list", () => {
    const { actions, dispatch } = actionsCollector();
    const { onSetupBack } = createSetupHandlers({
      dispatch,
      getPendingSetup: () => undefined,
      configDir,
    });

    onSetupBack();

    expect(actions.map((a) => a.type)).toEqual(["setup-step"]);
    const [action] = actions;
    expect(action?.type === "setup-step" && action.state.step).toBe("list");
  });

  test("selecting an unset OpenRouter row opens enter-key with no hosted note", () => {
    const { actions, dispatch } = actionsCollector();
    const { onSetupSelect } = createSetupHandlers({
      dispatch,
      getPendingSetup: () => undefined,
      configDir,
    });
    onSetupSelect({
      kind: "key",
      provider: "openrouter",
      keyName: "OPENROUTER_API_KEY",
      source: "unset",
      masked: undefined,
      removable: false,
    });
    expect(actions).toEqual([
      {
        type: "setup-step",
        state: {
          step: "enter-key",
          provider: "openrouter",
          keyName: "OPENROUTER_API_KEY",
          busy: false,
        },
      },
    ]);
  });

  test("saving an OpenRouter key while logged in lists it as unused under the seri plan", async () => {
    const originalSkip = process.env.SERI_SKIP_KEY_VALIDATION;
    process.env.SERI_SKIP_KEY_VALIDATION = "1";
    try {
      saveAuthSession(
        {
          accessToken: "at-1",
          refreshToken: "rt-1",
          userId: "user_1",
          email: "a@example.com",
          obtainedAt: "2026-01-01T00:00:00.000Z",
        },
        configDir,
      );
      const { actions, dispatch } = actionsCollector();
      const { onSetupKeyEntered } = createSetupHandlers({
        dispatch,
        getPendingSetup: () => undefined,
        configDir,
      });
      await onSetupKeyEntered("openrouter", "sk-or-own-override");
      const step = actions.find((a) => a.type === "setup-step" && a.state.step === "list");
      expect(step?.type === "setup-step" && step.state.step).toBe("list");
      if (step?.type !== "setup-step" || step.state.step !== "list") return;
      const row = step.state.rows.find(
        (entry) => entry.kind === "key" && entry.provider === "openrouter",
      );
      expect(row).toMatchObject({
        source: "config",
        removable: true,
        unusedBecause: "unused because a seri plan is connected",
      });
    } finally {
      if (originalSkip === undefined) delete process.env.SERI_SKIP_KEY_VALIDATION;
      else process.env.SERI_SKIP_KEY_VALIDATION = originalSkip;
    }
  });

  test("selecting a connected seri row asks to disconnect", () => {
    const { actions, dispatch } = actionsCollector();
    const { onSetupSelect } = createSetupHandlers({
      dispatch,
      getPendingSetup: () => undefined,
      configDir,
    });
    onSetupSelect({
      kind: "subscription",
      provider: "seri",
      status: { status: "connected", planType: "pro" },
    });
    expect(actions).toEqual([
      { type: "setup-step", state: { step: "confirm-disconnect", provider: "seri" } },
    ]);
  });

  test("confirming seri disconnect ignores the plan and keeps the login", () => {
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = configDir;
    try {
      saveAuthSession(
        {
          accessToken: "at-1",
          refreshToken: "rt-1",
          userId: "user_1",
          email: "a@example.com",
          obtainedAt: "2026-01-01T00:00:00.000Z",
        },
        configDir,
      );
      const { actions, dispatch } = actionsCollector();
      const { onSetupRemove } = createSetupHandlers({
        dispatch,
        getPendingSetup: () => ({ step: "confirm-disconnect", provider: "seri" }),
        configDir,
      });
      onSetupRemove({
        kind: "subscription",
        provider: "seri",
        status: { status: "connected" },
      });
      const step = actions.find((a) => a.type === "setup-step");
      expect(step?.type === "setup-step" && step.state.step).toBe("list");
      if (step?.type !== "setup-step" || step.state.step !== "list") return;
      const seri = step.state.rows.find(
        (entry) => entry.kind === "subscription" && entry.provider === "seri",
      );
      expect(seri).toMatchObject({ status: { status: "ignored" } });
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
    }
  });

  test("removing a local OpenRouter key while logged in leaves the seri plan, not a blank first run", () => {
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = configDir;
    try {
      saveAuthSession(
        {
          accessToken: "at-1",
          refreshToken: "rt-1",
          userId: "user_1",
          email: "a@example.com",
          obtainedAt: "2026-01-01T00:00:00.000Z",
        },
        configDir,
      );
      setConfigValue("OPENROUTER_API_KEY", "sk-or-own", configDir);
      const { actions, dispatch } = actionsCollector();
      const { onSetupRemove } = createSetupHandlers({
        dispatch,
        getPendingSetup: () => ({
          step: "confirm-remove",
          provider: "openrouter",
          keyName: "OPENROUTER_API_KEY",
        }),
        configDir,
      });
      onSetupRemove({
        kind: "key",
        provider: "openrouter",
        keyName: "OPENROUTER_API_KEY",
        source: "config",
        masked: "sk-o...own1",
        removable: true,
      });
      const step = actions.find((a) => a.type === "setup-step");
      expect(step?.type === "setup-step" && step.state.step).toBe("list");
      if (step?.type !== "setup-step" || step.state.step !== "list") return;
      const row = step.state.rows.find(
        (entry) => entry.kind === "key" && entry.provider === "openrouter",
      );
      const seri = step.state.rows.find(
        (entry) => entry.kind === "subscription" && entry.provider === "seri",
      );
      expect(row).toMatchObject({ source: "unset", removable: false });
      expect(seri).toMatchObject({ status: { status: "connected" } });
      expect(needsGuidedSetup(configDir)).toBe(false);
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
    }
  });

  test("onSetupBack on a corrupted config.json refreshes the list instead of closing the panel", () => {
    writeFileSync(join(configDir, "config.json"), "{ not json");
    const { actions, dispatch } = actionsCollector();
    const { onSetupBack } = createSetupHandlers({
      dispatch,
      getPendingSetup: () => ({
        step: "confirm-remove",
        provider: "groq",
        keyName: "GROQ_API_KEY",
      }),
      configDir,
    });

    onSetupBack();

    expect(actions.map((a) => a.type)).toEqual(["setup-step"]);
    const [action] = actions;
    expect(action?.type === "setup-step" && action.state.step).toBe("list");
  });

  test("onPanelClosed does not fire when a corrupted config.json still refreshes", () => {
    writeFileSync(join(configDir, "config.json"), "{ not json");
    const { dispatch } = actionsCollector();
    let panelClosedCount = 0;
    const { onSetupBack } = createSetupHandlers({
      dispatch,
      getPendingSetup: () => ({
        step: "confirm-remove",
        provider: "groq",
        keyName: "GROQ_API_KEY",
      }),
      configDir,
      onPanelClosed: () => {
        panelClosedCount += 1;
      },
    });

    onSetupBack();

    expect(panelClosedCount).toBe(0);
  });
});

describe("onSetupSelect for a Codex subscription row", () => {
  let configDir: string;
  let codexHome: string;
  const originalCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "seri-tui-handlers-codex-"));
    codexHome = mkdtempSync(join(tmpdir(), "seri-tui-handlers-codex-home-"));
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    rmSync(configDir, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  });

  test("does not open the API-key field", () => {
    const { actions, dispatch } = actionsCollector();
    const { onSetupSelect } = createSetupHandlers({
      dispatch,
      getPendingSetup: () => undefined,
      configDir,
    });

    onSetupSelect({
      kind: "subscription",
      provider: "openai",
      status: { status: "not-connected" },
      removable: false,
    });

    expect(actions).toEqual([
      {
        type: "setup-step",
        state: { step: "confirm-connect", provider: "openai", action: "connect" },
      },
    ]);
  });

  test("a connected row opens confirm-disconnect instead of the transcript", () => {
    const { actions, dispatch } = actionsCollector();
    const { onSetupSelect } = createSetupHandlers({
      dispatch,
      getPendingSetup: () => undefined,
      configDir,
    });

    onSetupSelect({
      kind: "subscription",
      provider: "openai",
      status: { status: "connected" },
      removable: true,
    });

    expect(actions).toEqual([
      { type: "setup-step", state: { step: "confirm-disconnect", provider: "openai" } },
    ]);
  });

  test("an ignored row opens confirm-connect to re-enable", () => {
    const { actions, dispatch } = actionsCollector();
    const { onSetupSelect } = createSetupHandlers({
      dispatch,
      getPendingSetup: () => undefined,
      configDir,
    });

    onSetupSelect({
      kind: "subscription",
      provider: "openai",
      status: { status: "ignored" },
      removable: false,
    });

    expect(actions).toEqual([
      {
        type: "setup-step",
        state: { step: "confirm-connect", provider: "openai", action: "reenable" },
      },
    ]);
  });

  test("confirm-disconnect unlinks the seri file, ignores leftover Codex auth, and refreshes", () => {
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "tok", account_id: "acct" },
      }),
    );
    const { actions, dispatch } = actionsCollector();
    const { onSetupRemove } = createSetupHandlers({
      dispatch,
      getPendingSetup: () => ({ step: "confirm-disconnect", provider: "openai" }),
      configDir,
    });

    onSetupRemove({
      kind: "subscription",
      provider: "openai",
      status: { status: "connected" },
      removable: true,
    });

    expect(actions.some((a) => a.type === "transcript-append")).toBe(true);
    const step = actions.find((a) => a.type === "setup-step");
    expect(step?.type === "setup-step" && step.state.step).toBe("list");
    expect(existsSync(join(configDir, CODEX_IGNORE_FILENAME))).toBe(true);
    expect(existsSync(join(codexHome, "auth.json"))).toBe(true);
  });

  test("confirm-connect clears the ignore and refreshes the list", () => {
    ignoreCodexSubscription(configDir);
    const { actions, dispatch } = actionsCollector();
    const { onSetupRemove } = createSetupHandlers({
      dispatch,
      getPendingSetup: () => ({ step: "confirm-connect", provider: "openai" }),
      configDir,
    });

    onSetupRemove({
      kind: "subscription",
      provider: "openai",
      status: { status: "ignored" },
      removable: false,
    });

    const step = actions.find((a) => a.type === "setup-step");
    expect(step?.type === "setup-step" && step.state.step).toBe("list");
    expect(existsSync(join(configDir, CODEX_IGNORE_FILENAME))).toBe(false);
  });
});

describe("dispatchConfigList (via onConfigBack)", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "seri-tui-handlers-test-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  // Guards the existing fix against regression and pins the symmetry item 1 restores between
  // /setup, /config and /permissions.
  test("a corrupted config.json refreshes the list instead of closing the panel", () => {
    writeFileSync(join(configDir, "config.json"), "{ not json");
    const { actions, dispatch } = actionsCollector();
    const { onConfigBack } = createConfigHandlers({
      dispatch,
      getPendingConfig: () => ({ step: "confirm-unset", key: "SERI_VERIFY_ENABLED" }),
      configDir,
    });

    onConfigBack();

    expect(actions.map((a) => a.type)).toEqual(["config-step"]);
    const [action] = actions;
    expect(action?.type === "config-step" && action.state.step).toBe("list");
  });
});

// The TUI header's effort-tier suffix (app.tsx) reads `state.config` via `loadReasoningEffortConfig`
// and has no turn to wait for on a /config-only edit — regression coverage for the gap a review
// found: saving/unsetting a config value here used to dispatch nothing, so the header kept showing
// whatever it last saw until the next turn ran.
describe("config-updated live dispatch (via onConfigSelect/onConfigValueEntered/onConfigUnset)", () => {
  let configDir: string;
  let originalReasoningEffort: string | undefined;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "seri-tui-handlers-test-"));
    // resolveConfigValue (config/config.ts) is env-first, so a developer's own shell exporting this
    // would make loadReasoningEffortConfig see it regardless of what these tests write to
    // config.json. Saved, not just deleted: bun runs every test file in one process, so leaving it
    // deleted here would affect every test after this describe block too.
    originalReasoningEffort = process.env.SERI_REASONING_EFFORT;
    delete process.env.SERI_REASONING_EFFORT;
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    if (originalReasoningEffort === undefined) delete process.env.SERI_REASONING_EFFORT;
    else process.env.SERI_REASONING_EFFORT = originalReasoningEffort;
  });

  // A latent gap a review found: this is the only one of the three /config write paths that
  // toggles rather than saves/unsets, and it was the one still missing this dispatch after the
  // other two were fixed — every boolean key happens not to be config-derived display state today,
  // which is exactly why it went unnoticed rather than why it was safe.
  test("toggling a boolean config value dispatches config-updated with the fresh record", () => {
    const { actions, dispatch } = actionsCollector();
    const { onConfigSelect } = createConfigHandlers({
      dispatch,
      getPendingConfig: () => undefined,
      configDir,
    });

    onConfigSelect("SERI_VERIFY_ENABLED");

    // configBoolean(undefined) is true (config.ts: `value !== "false"`), so the very first toggle
    // of an unset key flips it to "false", not "true".
    expect(actions).toContainEqual({
      type: "config-updated",
      config: { SERI_VERIFY_ENABLED: "false" },
    });
  });

  test("toggling the standing-deny key from unset writes true, not false", () => {
    const { actions, dispatch } = actionsCollector();
    const { onConfigSelect } = createConfigHandlers({
      dispatch,
      getPendingConfig: () => undefined,
      configDir,
    });

    onConfigSelect("SERI_BLOCK_READS_OUTSIDE_WORKING_DIRECTORIES");

    expect(actions).toContainEqual({
      type: "config-updated",
      config: { SERI_BLOCK_READS_OUTSIDE_WORKING_DIRECTORIES: "true" },
    });
  });

  test("saving a config value dispatches config-updated with the fresh record", () => {
    const { actions, dispatch } = actionsCollector();
    const { onConfigValueEntered } = createConfigHandlers({
      dispatch,
      getPendingConfig: () => undefined,
      configDir,
    });

    onConfigValueEntered("SERI_REASONING_EFFORT", "high");

    expect(actions).toContainEqual({
      type: "config-updated",
      config: { SERI_REASONING_EFFORT: "high" },
    });
  });

  test("unsetting a config value dispatches config-updated once it's actually removed", () => {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ SERI_REASONING_EFFORT: "medium" }),
    );
    const { actions, dispatch } = actionsCollector();
    const { onConfigUnset } = createConfigHandlers({
      dispatch,
      getPendingConfig: () => ({ step: "confirm-unset", key: "SERI_REASONING_EFFORT" }),
      configDir,
    });

    onConfigUnset("SERI_REASONING_EFFORT");

    expect(actions).toContainEqual({ type: "config-updated", config: {} });
  });

  test("unsetting a key that was already gone dispatches no config-updated", () => {
    const { actions, dispatch } = actionsCollector();
    const { onConfigUnset } = createConfigHandlers({
      dispatch,
      getPendingConfig: () => ({ step: "confirm-unset", key: "SERI_REASONING_EFFORT" }),
      configDir,
    });

    onConfigUnset("SERI_REASONING_EFFORT");

    expect(actions.some((a) => a.type === "config-updated")).toBe(false);
  });
});

describe("dispatchPermissionsList (via onPermissionsBack)", () => {
  let permissionsDir: string;
  let worktree: string;

  beforeEach(() => {
    permissionsDir = mkdtempSync(join(tmpdir(), "seri-tui-handlers-test-"));
    worktree = mkdtempSync(join(tmpdir(), "seri-tui-handlers-worktree-test-"));
  });

  afterEach(() => {
    rmSync(permissionsDir, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  // decidePermissionsOpen's own loadGrants call does NOT throw on a malformed permissions.yaml —
  // it degrades to an empty result and reports through the onWarning callback instead, which
  // dispatchPermissionsList wires straight to command-error (warnOnMalformedStore). The list step
  // still refreshes successfully right after, unlike the actual-throw case below.
  test("a malformed permissions.yaml surfaces the warning as a command-error", () => {
    writeFileSync(join(permissionsDir, "permissions.yaml"), ":::not yaml:::");
    const { actions, dispatch } = actionsCollector();
    const { onPermissionsBack } = createPermissionsHandlers({
      dispatch,
      getPendingPermissions: () => undefined,
      permissionsDir,
      getWorktree: () => worktree,
    });

    onPermissionsBack();

    expect(actions.map((a) => a.type)).toEqual(["command-error", "permissions-step"]);
  });

  test("a throwing getWorktree closes the panel instead of leaving confirm-remove stuck", () => {
    const { actions, dispatch } = actionsCollector();
    const { onPermissionsBack } = createPermissionsHandlers({
      dispatch,
      getPendingPermissions: () => ({ step: "confirm-remove", tool: "write_file" }),
      permissionsDir,
      getWorktree: () => {
        throw new Error("git rev-parse failed");
      },
    });

    onPermissionsBack();

    expect(actions.map((a) => a.type)).toEqual(["command-error", "permissions-resolved"]);
  });
});

// createEffortHandlers is the plumbing
// leftoverInput flows through end-to-end — verified directly at the unit level, since
// EffortPanel itself never produces a non-undefined leftoverInput today (it has no text-entry/
// paste concept — see EffortPanel.tsx's own comment).
describe("createEffortHandlers", () => {
  test("onEffortSelected dispatches effort-resolved with the tier and leftoverInput", () => {
    const { actions, dispatch } = actionsCollector();
    const { onEffortSelected } = createEffortHandlers({ dispatch });

    onEffortSelected("medium", "typed after close");

    expect(actions).toEqual([
      { type: "effort-resolved", tier: "medium", leftoverInput: "typed after close" },
    ]);
  });

  test("onEffortSelected with no leftoverInput dispatches it as undefined", () => {
    const { actions, dispatch } = actionsCollector();
    const { onEffortSelected } = createEffortHandlers({ dispatch });

    onEffortSelected("high");

    expect(actions).toEqual([{ type: "effort-resolved", tier: "high", leftoverInput: undefined }]);
  });

  test("onEffortCancel dispatches effort-resolved with no tier, but forwards leftoverInput", () => {
    const { actions, dispatch } = actionsCollector();
    const { onEffortCancel } = createEffortHandlers({ dispatch });

    onEffortCancel("typed after close");

    expect(actions).toEqual([
      { type: "effort-resolved", tier: undefined, leftoverInput: "typed after close" },
    ]);
  });
});
