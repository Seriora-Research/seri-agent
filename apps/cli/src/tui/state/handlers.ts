import type { ModelProvider } from "@seri/model-catalog";
import {
  connectCodex as connectCodexReal,
  disconnectCodex as disconnectCodexReal,
} from "../../auth/codexConnect";
import { reconnectCodex } from "../../auth/codexIgnore";
import { disconnectSeri, reconnectSeri } from "../../auth/seriIgnore";
import { login as loginReal, logout as logoutReal } from "../../auth/commands";
import { getWorkosClientId } from "../../auth/deviceFlow";
import {
  connectGrok as connectGrokReal,
  disconnectGrok as disconnectGrokReal,
} from "../../auth/xaiConnect";
import type { CliDeps } from "../../cli";
import { loadConfig, setConfigValue, unsetConfigValue } from "../../config/config";
import { messageOf } from "../../errors";
import { forgetGrant, loadGrants } from "../../permissions/store";
import {
  PROVIDER_API_KEY_NAMES,
  type ProviderKeyState,
  providerKeyState,
} from "../../provider/keys";
import { validateProviderKey } from "../../provider/validate";
import {
  configKeyInfo,
  booleanRowOn,
  decideAuthOffer,
  decideConfigOpen,
  decidePermissionsOpen,
  decideSetupOpen,
  firstSetupActionIndex,
  isSetupSubscriptionRow,
  type SetupProviderRow,
  setupRowId,
} from "./commands";
import type { ConfigPanelState, Dispatch, PermissionsPanelState, SetupState } from "./reducer";

export function createSetupHandlers(opts: {
  dispatch: Dispatch;
  getPendingSetup: () => SetupState | undefined;
  configDir: string;
  onPanelClosed?: () => void;
  onConnectGrok?: () => Promise<void>;
  onConnectCodex?: () => Promise<void>;
  onConnectSeri?: () => Promise<void>;
}): {
  onSetupSelect: (row: SetupProviderRow) => void;
  onSetupKeyEntered: (provider: ModelProvider, value: string) => Promise<void>;
  onSetupRemove: (row: SetupProviderRow) => void;
  onSetupBack: () => void;
} {
  const {
    dispatch,
    getPendingSetup,
    configDir,
    onPanelClosed,
    onConnectGrok,
    onConnectCodex,
    onConnectSeri,
  } = opts;

  function setupListState(selectedId?: string): SetupState {
    const rows = decideSetupOpen(configDir);
    const selected =
      selectedId === undefined
        ? firstSetupActionIndex(rows)
        : Math.max(
            firstSetupActionIndex(rows),
            rows.findIndex((row) => setupRowId(row) === selectedId),
          );
    return { step: "list", rows, selected };
  }

  function dispatchSetupList(selectedId?: string): void {
    try {
      dispatch({ type: "setup-step", state: setupListState(selectedId) });
    } catch (err) {
      dispatch({
        type: "command-error",
        message: messageOf(err),
      });
      dispatch({ type: "setup-resolved" });
      onPanelClosed?.();
    }
  }

  function onSetupSelect(row: SetupProviderRow): void {
    if (row.kind === "heading") return;
    if (isSetupSubscriptionRow(row)) {
      if (row.provider === "xai") {
        dispatch({
          type: "setup-step",
          state: {
            step: row.connected ? "confirm-disconnect" : "confirm-connect",
            provider: "xai",
          },
        });
        return;
      }
      if (row.provider === "seri") {
        if (row.status.status === "connected") {
          dispatch({
            type: "setup-step",
            state: { step: "confirm-disconnect", provider: "seri" },
          });
          return;
        }
        if (row.status.status === "ignored") {
          dispatch({
            type: "setup-step",
            state: { step: "confirm-connect", provider: "seri" },
          });
          return;
        }
        dispatch({ type: "setup-resolved" });
        void onConnectSeri?.();
        return;
      }
      if (row.status.status === "connected") {
        dispatch({
          type: "setup-step",
          state: { step: "confirm-disconnect", provider: "openai" },
        });
        return;
      }
      if (row.status.status === "ignored") {
        dispatch({
          type: "setup-step",
          state: { step: "confirm-connect", provider: "openai", action: "reenable" },
        });
        return;
      }
      dispatch({
        type: "setup-step",
        state: { step: "confirm-connect", provider: "openai", action: "connect" },
      });
      return;
    }
    dispatch({
      type: "setup-step",
      state: {
        step: "enter-key",
        provider: row.provider,
        keyName: PROVIDER_API_KEY_NAMES[row.provider],
        busy: false,
      },
    });
  }

  async function onSetupKeyEntered(provider: ModelProvider, value: string): Promise<void> {
    const keyName = PROVIDER_API_KEY_NAMES[provider];
    dispatch({
      type: "setup-step",
      state: { step: "enter-key", provider, keyName, busy: true },
    });
    const result = await validateProviderKey(provider, value);
    if (!result.ok) {
      dispatch({
        type: "setup-step",
        state: { step: "enter-key", provider, keyName, busy: false, error: result.message },
      });
      return;
    }
    try {
      setConfigValue(keyName, value, configDir);
    } catch (err) {
      dispatch({
        type: "setup-step",
        state: {
          step: "enter-key",
          provider,
          keyName,
          busy: false,
          error: messageOf(err),
        },
      });
      return;
    }
    dispatch({
      type: "transcript-append",
      line:
        result.warning === undefined
          ? `Saved ${keyName}.`
          : `Saved ${keyName}. ⚠ ${result.warning}`,
    });
    try {
      dispatch({ type: "setup-step", state: setupListState(`key:${provider}`) });
    } catch (err) {
      dispatch({
        type: "setup-step",
        state: {
          step: "enter-key",
          provider,
          keyName,
          busy: false,
          error: messageOf(err),
        },
      });
    }
  }

  function onSetupRemove(row: SetupProviderRow): void {
    const pending = getPendingSetup();
    if (pending?.step === "confirm-disconnect") {
      try {
        const onMessage = (message: string) => {
          dispatch({ type: "transcript-append", line: message });
        };
        if (pending.provider === "openai") disconnectCodexReal(configDir, onMessage);
        else if (pending.provider === "seri") disconnectSeri(configDir, onMessage);
        else disconnectGrokReal(configDir, onMessage);
      } catch (err) {
        dispatch({ type: "command-error", message: messageOf(err) });
        return;
      }
      dispatchSetupList(`subscription:${pending.provider}`);
      return;
    }
    if (pending?.step === "confirm-connect") {
      if (pending.provider === "openai") {
        if (pending.action === "connect") {
          dispatch({ type: "setup-resolved" });
          void onConnectCodex?.();
          return;
        }
        try {
          reconnectCodex(configDir, (message) => {
            dispatch({ type: "transcript-append", line: message });
          });
        } catch (err) {
          dispatch({ type: "command-error", message: messageOf(err) });
          return;
        }
        dispatchSetupList("subscription:openai");
        return;
      }
      if (pending.provider === "seri") {
        try {
          reconnectSeri(configDir, (message) => {
            dispatch({ type: "transcript-append", line: message });
          });
        } catch (err) {
          dispatch({ type: "command-error", message: messageOf(err) });
          return;
        }
        dispatchSetupList("subscription:seri");
        return;
      }
      dispatch({ type: "setup-resolved" });
      void onConnectGrok?.();
      return;
    }
    if (pending?.step === "confirm-remove") {
      const { keyName, provider } = pending;
      try {
        unsetConfigValue(keyName, configDir);
      } catch (err) {
        dispatch({
          type: "command-error",
          message: messageOf(err),
        });
        return;
      }
      dispatch({ type: "transcript-append", line: `Removed ${keyName}.` });
      dispatchSetupList(`key:${provider}`);
      return;
    }
    if (row.kind !== "key") return;
    let state: ProviderKeyState;
    try {
      state = providerKeyState(row.provider, configDir);
    } catch (err) {
      dispatch({
        type: "command-error",
        message: messageOf(err),
      });
      return;
    }
    if (!state.hasConfigEntry) return;
    dispatch({
      type: "setup-step",
      state: { step: "confirm-remove", provider: row.provider, keyName: state.keyName },
    });
  }

  function onSetupBack(): void {
    const current = getPendingSetup();
    const selectedId =
      current?.step === "enter-key"
        ? `key:${current.provider}`
        : current?.step === "confirm-remove"
          ? `key:${current.provider}`
          : current?.step === "confirm-connect" || current?.step === "confirm-disconnect"
            ? `subscription:${current.provider}`
            : undefined;
    dispatchSetupList(selectedId);
  }

  return { onSetupSelect, onSetupKeyEntered, onSetupRemove, onSetupBack };
}

export function createAuthHandlers(opts: {
  dispatch: Dispatch;
  deps: Pick<CliDeps, "login" | "logout" | "connectGrok" | "connectCodex">;
  configDir: string;
}): {
  onLogin: (mode: "login" | "signup") => Promise<void>;
  onLogout: () => void;
  onAbandon: () => void;
  onConnectGrok: () => Promise<void>;
  onConnectCodex: () => Promise<void>;
} {
  const { dispatch, deps, configDir } = opts;
  const loginFn = deps.login ?? loginReal;
  const logoutFn = deps.logout ?? logoutReal;
  const connectGrokFn = deps.connectGrok ?? connectGrokReal;
  const connectCodexFn = deps.connectCodex ?? connectCodexReal;
  // Abort the in-flight device-flow poll; a device code stays valid for minutes and login() would otherwise keep polling after dismiss.
  let attemptCounter = 0;
  let currentController: AbortController | undefined;

  async function onLogin(mode: "login" | "signup"): Promise<void> {
    const myAttempt = ++attemptCounter;
    const controller = new AbortController();
    currentController = controller;
    dispatch({ type: "auth-requested", mode });
    try {
      const clientId = getWorkosClientId(configDir);
      await loginFn(mode, clientId, configDir, {
        onDeviceCode: (device) => {
          if (myAttempt !== attemptCounter) return;
          dispatch({
            type: "auth-step",
            state: {
              step: "device",
              mode,
              verificationUri: device.verificationUri,
              userCode: device.userCode,
            },
          });
        },
        onMessage: (message) => {
          if (myAttempt !== attemptCounter) return;
          dispatch({ type: "transcript-append", line: message });
        },
        signal: controller.signal,
      });
      if (myAttempt !== attemptCounter) return;
      dispatch({ type: "auth-resolved" });
      dispatch({ type: "auth-offer", show: decideAuthOffer(configDir) });
    } catch (err) {
      if (myAttempt !== attemptCounter) return;
      dispatch({
        type: "auth-step",
        state: {
          step: "result",
          message: messageOf(err),
          error: true,
        },
      });
    }
  }

  async function onConnectGrok(): Promise<void> {
    const myAttempt = ++attemptCounter;
    const controller = new AbortController();
    currentController = controller;
    dispatch({ type: "auth-requested", mode: "grok" });
    try {
      await connectGrokFn(configDir, {
        onDeviceCode: (device) => {
          if (myAttempt !== attemptCounter) return;
          dispatch({
            type: "auth-step",
            state: {
              step: "device",
              mode: "grok",
              verificationUri: device.verificationUri,
              userCode: device.userCode,
            },
          });
        },
        onMessage: (message) => {
          if (myAttempt !== attemptCounter) return;
          dispatch({ type: "transcript-append", line: message });
        },
        signal: controller.signal,
      });
      if (myAttempt !== attemptCounter) return;
      dispatch({ type: "auth-resolved" });
    } catch (err) {
      if (myAttempt !== attemptCounter) return;
      dispatch({
        type: "auth-step",
        state: {
          step: "result",
          message: messageOf(err),
          error: true,
        },
      });
    }
  }

  async function onConnectCodex(): Promise<void> {
    const myAttempt = ++attemptCounter;
    const controller = new AbortController();
    currentController = controller;
    dispatch({ type: "auth-requested", mode: "codex" });
    try {
      await connectCodexFn(configDir, {
        onAuthorizeUrl: (url) => {
          if (myAttempt !== attemptCounter) return;
          dispatch({
            type: "auth-step",
            state: { step: "browser", mode: "codex", verificationUri: url },
          });
        },
        onMessage: (message) => {
          if (myAttempt !== attemptCounter) return;
          dispatch({ type: "transcript-append", line: message });
        },
        signal: controller.signal,
      });
      if (myAttempt !== attemptCounter) return;
      dispatch({ type: "auth-resolved" });
    } catch (err) {
      if (myAttempt !== attemptCounter) return;
      dispatch({
        type: "auth-step",
        state: {
          step: "result",
          message: messageOf(err),
          error: true,
        },
      });
    }
  }

  function onLogout(): void {
    try {
      logoutFn(configDir, (message) => {
        dispatch({ type: "transcript-append", line: message });
      });
    } catch (err) {
      dispatch({
        type: "auth-step",
        state: {
          step: "result",
          message: messageOf(err),
          error: true,
        },
      });
    }
    dispatch({ type: "auth-offer", show: decideAuthOffer(configDir) });
  }

  function onAbandon(): void {
    attemptCounter += 1;
    currentController?.abort();
  }

  return { onLogin, onLogout, onAbandon, onConnectGrok, onConnectCodex };
}

function verifyConfigTakesEffectNote(key: string): string {
  return configKeyInfo(key).takesEffectNextRun ? " (takes effect on the next run)" : "";
}

export function createConfigHandlers(opts: {
  dispatch: Dispatch;
  getPendingConfig: () => ConfigPanelState | undefined;
  configDir: string;
}): {
  onConfigSelect: (key: string) => void;
  onConfigValueEntered: (key: string, value: string) => void;
  onConfigUnset: (key: string) => void;
  onConfigBack: () => void;
} {
  const { dispatch, getPendingConfig, configDir } = opts;

  function configListState(selectedKey?: string): ConfigPanelState {
    const rows = decideConfigOpen(configDir);
    const selected =
      selectedKey === undefined
        ? 0
        : Math.max(
            0,
            rows.findIndex((row) => row.key === selectedKey),
          );
    return { step: "list", rows, selected };
  }

  function dispatchConfigList(selectedKey?: string): void {
    try {
      dispatch({ type: "config-step", state: configListState(selectedKey) });
    } catch (err) {
      dispatch({
        type: "command-error",
        message: messageOf(err),
      });
      dispatch({ type: "config-resolved" });
    }
  }

  function dispatchConfigUpdated(): void {
    try {
      dispatch({ type: "config-updated", config: loadConfig(configDir) });
    } catch {}
  }

  function onConfigSelect(key: string): void {
    if (configKeyInfo(key).kind !== "boolean") {
      dispatch({ type: "config-step", state: { step: "enter-value", key, busy: false } });
      return;
    }
    let nextOn: boolean;
    try {
      nextOn = !booleanRowOn(key, loadConfig(configDir)[key]);
      setConfigValue(key, String(nextOn), configDir);
    } catch (err) {
      dispatch({
        type: "command-error",
        message: messageOf(err),
      });
      return;
    }
    dispatchConfigUpdated();
    const envWins = Boolean(process.env[key]);
    dispatch({
      type: "transcript-append",
      line: envWins
        ? `${configKeyInfo(key).label}: ${nextOn ? "on" : "off"} in config, ${key} env still wins.`
        : `${configKeyInfo(key).label} is now ${nextOn ? "on" : "off"}.${verifyConfigTakesEffectNote(key)}`,
    });
    dispatchConfigList(key);
  }

  function onConfigValueEntered(key: string, value: string): void {
    dispatch({ type: "config-step", state: { step: "enter-value", key, busy: true } });
    try {
      setConfigValue(key, value, configDir);
    } catch (err) {
      dispatch({
        type: "config-step",
        state: {
          step: "enter-value",
          key,
          busy: false,
          error: messageOf(err),
        },
      });
      return;
    }
    dispatchConfigUpdated();
    dispatch({
      type: "transcript-append",
      line: `Saved ${key}.${verifyConfigTakesEffectNote(key)}`,
    });
    try {
      dispatch({ type: "config-step", state: configListState(key) });
    } catch (err) {
      dispatch({
        type: "config-step",
        state: {
          step: "enter-value",
          key,
          busy: false,
          error: messageOf(err),
        },
      });
    }
  }

  function onConfigUnset(key: string): void {
    const pending = getPendingConfig();
    if (pending?.step === "confirm-unset") {
      const { key: confirmedKey } = pending;
      let removed: boolean;
      try {
        removed = unsetConfigValue(confirmedKey, configDir);
      } catch (err) {
        dispatch({
          type: "command-error",
          message: messageOf(err),
        });
        return;
      }
      if (removed) dispatchConfigUpdated();
      dispatch({
        type: "transcript-append",
        line: removed
          ? `Removed ${confirmedKey}.${verifyConfigTakesEffectNote(confirmedKey)}`
          : `${confirmedKey} was not set.`,
      });
      dispatchConfigList(confirmedKey);
      return;
    }
    let hasConfigEntry: boolean;
    try {
      hasConfigEntry = Object.hasOwn(loadConfig(configDir), key);
    } catch (err) {
      dispatch({
        type: "command-error",
        message: messageOf(err),
      });
      return;
    }
    if (!hasConfigEntry) return;
    dispatch({ type: "config-step", state: { step: "confirm-unset", key } });
  }

  function onConfigBack(): void {
    const current = getPendingConfig();
    const key = current !== undefined && current.step !== "list" ? current.key : undefined;
    dispatchConfigList(key);
  }

  return { onConfigSelect, onConfigValueEntered, onConfigUnset, onConfigBack };
}

export function createPermissionsHandlers(opts: {
  dispatch: Dispatch;
  getPendingPermissions: () => PermissionsPanelState | undefined;
  permissionsDir: string;
  getWorktree: () => string;
}): {
  onPermissionsRemove: (tool: string) => void;
  onPermissionsBack: () => void;
} {
  const { dispatch, getPendingPermissions, permissionsDir, getWorktree } = opts;

  const warnOnMalformedStore = (message: string) => dispatch({ type: "command-error", message });

  function permissionsListState(selectedTool?: string): PermissionsPanelState {
    const rows = decidePermissionsOpen(permissionsDir, getWorktree(), warnOnMalformedStore);
    const selected =
      selectedTool === undefined
        ? 0
        : Math.max(
            0,
            rows.findIndex((row) => row.tool === selectedTool),
          );
    return { step: "list", rows, selected };
  }

  function dispatchPermissionsList(selectedTool?: string): void {
    try {
      dispatch({ type: "permissions-step", state: permissionsListState(selectedTool) });
    } catch (err) {
      dispatch({
        type: "command-error",
        message: messageOf(err),
      });
      dispatch({ type: "permissions-resolved" });
    }
  }

  function onPermissionsRemove(tool: string): void {
    const pending = getPendingPermissions();
    if (pending?.step === "confirm-remove") {
      const { tool: confirmedTool } = pending;
      // Hoist getWorktree(); it spawns git rev-parse.
      const worktree = getWorktree();
      let warned: string | undefined;
      let result: { global: boolean; project: boolean };
      try {
        result = forgetGrant(permissionsDir, worktree, confirmedTool, "project", (m) => {
          warned = m;
        });
      } catch (err) {
        dispatch({
          type: "command-error",
          message: messageOf(err),
        });
        return;
      }
      if (warned !== undefined) {
        dispatch({ type: "command-error", message: warned });
        dispatch({ type: "permissions-resolved" });
        return;
      }
      const stillGlobal = loadGrants(permissionsDir, worktree).global.includes(confirmedTool);
      let line: string;
      if (result.project && stillGlobal) {
        line = `Removed ${confirmedTool} from this project — still pre-approved globally.`;
      } else if (result.project) {
        line = `Removed ${confirmedTool}.`;
      } else if (stillGlobal) {
        line = `${confirmedTool} is still pre-approved globally.`;
      } else {
        line = `${confirmedTool} was not permanently approved.`;
      }
      dispatch({ type: "transcript-append", line });
      dispatchPermissionsList();
      return;
    }
    let removable: boolean;
    try {
      removable = loadGrants(permissionsDir, getWorktree(), warnOnMalformedStore).project.includes(
        tool,
      );
    } catch (err) {
      dispatch({
        type: "command-error",
        message: messageOf(err),
      });
      return;
    }
    if (!removable) return;
    dispatch({ type: "permissions-step", state: { step: "confirm-remove", tool } });
  }

  function onPermissionsBack(): void {
    const current = getPendingPermissions();
    const tool = current !== undefined && current.step !== "list" ? current.tool : undefined;
    dispatchPermissionsList(tool);
  }

  return { onPermissionsRemove, onPermissionsBack };
}

export function createEffortHandlers(opts: { dispatch: Dispatch }): {
  onEffortSelected: (tier: string, leftoverInput?: string) => void;
  onEffortCancel: (leftoverInput?: string) => void;
} {
  const { dispatch } = opts;

  function onEffortSelected(tier: string, leftoverInput?: string): void {
    dispatch({ type: "effort-resolved", tier, leftoverInput });
  }

  function onEffortCancel(leftoverInput?: string): void {
    dispatch({ type: "effort-resolved", leftoverInput });
  }

  return { onEffortSelected, onEffortCancel };
}
