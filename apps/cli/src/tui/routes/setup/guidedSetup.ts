import { randomUUID } from "node:crypto";
import type { ModelCatalog, ModelProvider } from "@seri/model-catalog";
import { createElement } from "react";
import { loadConfig } from "../../../config/config";
import { messageOf } from "../../../errors";
import { catalogWithFallback } from "../../../provider/catalog";
import { persistDefaultModel } from "../../../provider/defaults";
import { configuredProviders } from "../../../provider/keys";
import { subscribedProviders } from "../../../provider/subscriptions";
import { App } from "../../app";
import { getTuiRenderer } from "../../runtime/renderer";
import { decideGuidedModelPickerOpen, decideSetupOpen } from "../../state/commands";
import { createAuthHandlers, createSetupHandlers } from "../../state/handlers";
import { type Dispatch, initialTuiState, type TuiState, tuiReducer } from "../../state/reducer";

const GUIDED_MODEL_PROMPT = "Pick a default model to continue.";
const GUIDED_MODEL_REQUIRED = "Pick a model to continue — Ctrl-C to quit without saving one.";
const GUIDED_MODEL_LOADING = "Loading available models…";
const GUIDED_MODEL_STILL_LOADING = "Still loading available models — one moment.";

export async function runGuidedSetup(
  configDir: string,
  catalogPromise: Promise<ModelCatalog>,
): Promise<void> {
  const { root } = await getTuiRenderer(configDir);

  let liveState: TuiState = initialTuiState({
    id: randomUUID(),
    cwd: process.cwd(),
    systemPrompt: "",
    permissionMode: "approve-each",
    messages: [],
  });
  let reactDispatch: Dispatch | undefined;
  const dispatch: Dispatch = (action) => {
    liveState = tuiReducer(liveState, action);
    reactDispatch?.(action);
  };

  let resolveClosed!: () => void;

  const { onConnectGrok, onConnectCodex, onLogin } = createAuthHandlers({
    dispatch,
    deps: {},
    configDir,
  });
  const { onSetupSelect, onSetupKeyEntered, onSetupRemove, onSetupBack } = createSetupHandlers({
    dispatch,
    getPendingSetup: () => liveState.pendingSetup,
    configDir,
    onPanelClosed: () => resolveClosed(),
    onConnectGrok,
    onConnectCodex,
    onConnectSeri: () => onLogin("login"),
  });

  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  function onGuidedModelPickerCancel(): void {
    dispatch({ type: "command-error", message: GUIDED_MODEL_REQUIRED });
  }

  function onGuidedModelSelected(pick: {
    model: string;
    provider: ModelProvider;
    keyConfigured: boolean;
  }): void {
    try {
      persistDefaultModel(pick, configDir);
    } catch (err) {
      dispatch({
        type: "command-error",
        message: messageOf(err),
      });
      return;
    }
    dispatch({ type: "model-picker-resolved", pick });
    resolveClosed();
  }

  let closing = false;

  function closeWithoutPicker(): void {
    dispatch({ type: "setup-resolved" });
    resolveClosed();
  }

  function onSetupClose(): void {
    if (closing) {
      dispatch({ type: "command-error", message: GUIDED_MODEL_STILL_LOADING });
      return;
    }
    let configured: ReadonlySet<ModelProvider>;
    try {
      configured = new Set([...configuredProviders(configDir), ...subscribedProviders(configDir)]);
    } catch {
      closeWithoutPicker();
      return;
    }
    if (configured.size === 0) {
      closeWithoutPicker();
      return;
    }
    closing = true;
    dispatch({ type: "transcript-append", line: GUIDED_MODEL_LOADING });
    catalogPromise.then(
      (catalog) => {
        closing = false;
        if (liveState.pendingSetup?.step !== "list") return;
        try {
          const freshConfigured = new Set([
            ...configuredProviders(configDir),
            ...subscribedProviders(configDir),
          ]);
          if (freshConfigured.size === 0) {
            closeWithoutPicker();
            return;
          }
          const entries = decideGuidedModelPickerOpen(
            catalogWithFallback(catalog, freshConfigured),
            freshConfigured,
          );
          if (entries.length === 0) {
            closeWithoutPicker();
            return;
          }
          dispatch({ type: "transcript-append", line: GUIDED_MODEL_PROMPT });
          dispatch({ type: "model-picker-requested", entries });
          dispatch({ type: "setup-resolved" });
        } catch {
          closeWithoutPicker();
        }
      },
      () => {
        closing = false;
        closeWithoutPicker();
      },
    );
  }

  let initialConfig: Record<string, string>;
  try {
    initialConfig = loadConfig(configDir);
  } catch {
    initialConfig = {};
  }

  root.render(
    createElement(App, {
      session: liveState.session,
      route: undefined,
      catalog: undefined,
      config: initialConfig,
      onQuit: onSetupClose,
      onModelSelected: onGuidedModelSelected,
      onModelPickerCancel: onGuidedModelPickerCancel,
      onSetupSelect,
      onSetupKeyEntered,
      onSetupRemove,
      onSetupBack,
      onSetupClose,
      connectDispatch: (reducerDispatch: Dispatch) => {
        reactDispatch = reducerDispatch;
        try {
          dispatch({ type: "setup-requested", rows: decideSetupOpen(configDir) });
        } catch {
          resolveClosed();
        }
      },
    }),
  );

  await closed;
}
