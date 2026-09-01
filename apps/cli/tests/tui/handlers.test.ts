import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("onSetupBack on a corrupted config.json closes the panel instead of leaving confirm-remove stuck", () => {
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

    expect(actions.map((a) => a.type)).toEqual(["command-error", "setup-resolved"]);
  });

  test("onPanelClosed fires exactly once when the refresh fails", () => {
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

    expect(panelClosedCount).toBe(1);
  });
});

describe("onSetupSelect for a Codex subscription row", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "seri-tui-handlers-codex-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
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
      status: { status: "not-installed" },
      removable: false,
    });

    expect(actions.map((a) => a.type)).toEqual(["transcript-append"]);
    expect(actions[0]).toMatchObject({
      type: "transcript-append",
      line: expect.stringContaining("Codex CLI is not installed"),
    });
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
  test("a corrupted config.json closes the panel instead of leaving confirm-unset stuck", () => {
    writeFileSync(join(configDir, "config.json"), "{ not json");
    const { actions, dispatch } = actionsCollector();
    const { onConfigBack } = createConfigHandlers({
      dispatch,
      getPendingConfig: () => ({ step: "confirm-unset", key: "SERI_VERIFY_ENABLED" }),
      configDir,
    });

    onConfigBack();

    expect(actions.map((a) => a.type)).toEqual(["command-error", "config-resolved"]);
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
