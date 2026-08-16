import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSetupHandlers } from "../../src/tui/handlers";
import type { TuiAction } from "../../src/tui/reducer";

describe("dispatchSetupList (via onSetupBack)", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "seri-tui-handlers-test-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  test("a valid config.json refreshes the list", () => {
    const actions: TuiAction[] = [];
    const dispatch: (action: TuiAction) => void = (action) => {
      actions.push(action);
    };
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
    const actions: TuiAction[] = [];
    const dispatch: (action: TuiAction) => void = (action) => {
      actions.push(action);
    };
    const { onSetupBack } = createSetupHandlers({
      dispatch,
      getPendingSetup: () => ({ step: "confirm-remove", provider: "groq", keyName: "GROQ_API_KEY" }),
      configDir,
    });

    onSetupBack();

    expect(actions.map((a) => a.type)).toEqual(["command-error", "setup-resolved"]);
  });

  test("onPanelClosed fires exactly once when the refresh fails", () => {
    writeFileSync(join(configDir, "config.json"), "{ not json");
    const actions: TuiAction[] = [];
    const dispatch: (action: TuiAction) => void = (action) => {
      actions.push(action);
    };
    let panelClosedCount = 0;
    const { onSetupBack } = createSetupHandlers({
      dispatch,
      getPendingSetup: () => ({ step: "confirm-remove", provider: "groq", keyName: "GROQ_API_KEY" }),
      configDir,
      onPanelClosed: () => {
        panelClosedCount += 1;
      },
    });

    onSetupBack();

    expect(panelClosedCount).toBe(1);
  });
});
