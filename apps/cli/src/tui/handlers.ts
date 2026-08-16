import type { ModelProvider } from "@seri/model-catalog";
import { login as loginReal, logout as logoutReal } from "../auth/commands";
import { getWorkosClientId } from "../auth/deviceFlow";
import type { CliDeps } from "../cli";
import { configBoolean, loadConfig, setConfigValue, unsetConfigValue } from "../config/config";
import { forgetGrant, loadGrants } from "../permissions/store";
import { PROVIDER_API_KEY_NAMES, type ProviderKeyState, providerKeyState } from "../provider/keys";
import { validateProviderKey } from "../provider/validate";
import {
  configKeyInfo,
  decideAuthOffer,
  decideConfigOpen,
  decidePermissionsOpen,
  decideSetupOpen,
} from "./commands";
import type { ConfigPanelState, Dispatch, PermissionsPanelState, SetupState } from "./reducer";

// /setup's own five handlers, mirroring cli.ts's /model pair (onModelSelected/onModelPickerCancel) —
// each does nothing but recompute the current truth (decideSetupOpen re-reads config.json/env every
// time, never trusting a stale copy) and dispatch it. `setupListState` is the one piece shared
// by every path that returns to the list step: fresh rows, plus — when a specific provider is
// named — that row's own index, so returning from enter-key/confirm-remove re-highlights the row
// the user was just looking at instead of always snapping back to the top.
//
// Extracted (byok-guided-setup, feature-plan.md) so both `runTui` and the blank-first-run
// bootstrap (`runGuidedSetup`, tui/guidedSetup.ts — threaded this factory in as a parameter rather
// than importing it there, code-review finding PR #91 round 2) share one copy of this logic rather
// than diverging over time. `getPendingSetup` is a live accessor (not a captured snapshot) — each
// caller passes in a closure that reads its own current reducer state, matching the semantics
// `liveState.pendingSetup` had before this extraction.
export function createSetupHandlers(opts: {
  dispatch: Dispatch;
  getPendingSetup: () => SetupState | undefined;
  configDir: string;
}): {
  onSetupSelect: (provider: ModelProvider) => void;
  onSetupKeyEntered: (provider: ModelProvider, value: string) => Promise<void>;
  onSetupRemove: (provider: ModelProvider) => void;
  onSetupBack: () => void;
} {
  const { dispatch, getPendingSetup, configDir } = opts;

  function setupListState(selectedProvider?: ModelProvider): SetupState {
    const rows = decideSetupOpen(configDir);
    const selected =
      selectedProvider === undefined
        ? 0
        : Math.max(
            0,
            rows.findIndex((row) => row.provider === selectedProvider),
          );
    return { step: "list", rows, selected };
  }

  // A shared "refresh the list, degrade to command-error if that throws" primitive (code-review
  // finding, PR #73, round 2): decideSetupOpen reads config.json, and a malformed file is exactly
  // as reachable once the panel is already open (a racing second `seri` process, a hand edit) as it
  // is at the /setup-OPEN interceptor (cli.ts) — which the round 1 fix already guarded. Used by
  // onSetupRemove's success path and onSetupBack — round 1 missed both, reached only from INSIDE an
  // already-open panel, with nothing above them to catch a throw out of their own `useInput`
  // callback. NOT used by onSetupKeyEntered's own success path (round 3, item #3): that one needs
  // its OWN inline catch instead, to reset `busy: false` on a refresh failure rather than just
  // showing a command-error while leaving the panel's own busy gate stuck — see its own comment.
  function dispatchSetupList(selectedProvider?: ModelProvider): void {
    try {
      dispatch({ type: "setup-step", state: setupListState(selectedProvider) });
    } catch (err) {
      dispatch({
        type: "command-error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // No config.json read here at all (code-review finding, PR #73, round 2): a row's `keyName` is a
  // pure function of `provider` (PROVIDER_API_KEY_NAMES), so the old `decideSetupOpen(configDir).
  // find(...)` — the full 5-provider scan, just to pull one static field back out of it — was both
  // slower and a needless crash surface for a value that never needed I/O to produce.
  function onSetupSelect(provider: ModelProvider): void {
    dispatch({
      type: "setup-step",
      state: {
        step: "enter-key",
        provider,
        keyName: PROVIDER_API_KEY_NAMES[provider],
        busy: false,
      },
    });
  }

  // D5's own probe, then D6's own write — `validateProviderKey` never throws (its own contract:
  // every failure mode resolves to a result, not a rejection), so only the config write itself
  // needs a try/catch, matching the persist path's degrade-to-a-message posture (onSessionChange's
  // own comment, above) rather than converting a validated key into a lost one over an unrelated
  // write failure.
  //
  // `keyName` is PROVIDER_API_KEY_NAMES[provider] directly, not a decideSetupOpen scan (code-review
  // finding, PR #73, round 2 — same fix as onSetupSelect just above): no config.json read here at
  // all, which is also what makes the rest of this function need no crash guard of its own.
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
      // Bug fixed here (code-review, PR #73): this used to dispatch a bare command-error and
      // return, leaving `pendingSetup` stuck at `busy: true` — SetupEnterKey's own useInput
      // checks `if (busy) return;` BEFORE its Escape/Ctrl-D handling, so a write failure here
      // (EACCES, disk full, the config dir removed mid-session) permanently locked the /setup
      // panel with no way out short of a fatal Ctrl-C that kills the whole process. Re-rendering
      // `enter-key` with `busy: false` and an error, the same shape a validation failure already
      // uses above, is what actually returns control to the user.
      dispatch({
        type: "setup-step",
        state: {
          step: "enter-key",
          provider,
          keyName,
          busy: false,
          error: err instanceof Error ? err.message : String(err),
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
    // NOT dispatchSetupList (code-review finding, PR #73, round 3, item #3): that helper's own
    // catch only dispatches command-error, which never touches `pendingSetup` — leaving THIS
    // function's own `busy: true` (set above, before the validate/write round-trip) stuck forever
    // if the refresh read (setupListState -> decideSetupOpen -> config.json) throws, the exact
    // lockout class the write-failure catch above already fixed, just reached by a different
    // trigger (the post-write refresh failing, not the write itself). Resetting `busy: false`
    // here, inline, the same shape that catch already uses, is what actually clears it —
    // SetupEnterKey's own `if (busy) return;` gate is what makes that necessary.
    try {
      dispatch({ type: "setup-step", state: setupListState(provider) });
    } catch (err) {
      dispatch({
        type: "setup-step",
        state: {
          step: "enter-key",
          provider,
          keyName,
          busy: false,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  // D8: this is the SAME prop SetupList's own 'r' keypress and SetupConfirmRemove's own 'y'
  // keypress both call — App.tsx has only five /setup props total, no separate "request
  // confirmation" one — so which one this call means is read off the CURRENT live reducer state,
  // the same "trust liveState, not a caller-captured copy" pattern this closure already uses
  // throughout (this function's own top comment).
  function onSetupRemove(provider: ModelProvider): void {
    const pending = getPendingSetup();
    if (pending?.step === "confirm-remove") {
      const { keyName } = pending;
      try {
        unsetConfigValue(keyName, configDir);
      } catch (err) {
        dispatch({
          type: "command-error",
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      dispatch({ type: "transcript-append", line: `Removed ${keyName}.` });
      dispatchSetupList(provider);
      return;
    }
    // `providerKeyState` for the one provider under the cursor, not a decideSetupOpen scan of all
    // five (code-review finding, PR #73, round 2) — still real I/O (config.json), so still needs
    // its own guard: a malformed file here used to throw straight out of this `useInput` callback,
    // the same class of bug round 1 fixed for the /setup-OPEN interceptor but missed here.
    let state: ProviderKeyState;
    try {
      state = providerKeyState(provider, configDir);
    } catch (err) {
      dispatch({
        type: "command-error",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!state.hasConfigEntry) return;
    dispatch({
      type: "setup-step",
      state: { step: "confirm-remove", provider, keyName: state.keyName },
    });
  }

  function onSetupBack(): void {
    const current = getPendingSetup();
    const provider =
      current !== undefined && current.step !== "list" ? current.provider : undefined;
    dispatchSetupList(provider);
  }

  return { onSetupSelect, onSetupKeyEntered, onSetupRemove, onSetupBack };
}

// Stage C (cli-commands-to-tui feature-plan.md): /login, /signup and /logout's own two handlers,
// mirroring createSetupHandlers's exact shape (dispatch/deps/configDir in). `deps.login ?? loginReal`
// / `deps.logout ?? logoutReal` is the SAME injection seam handleAuthCommand already uses for the
// non-interactive `seri login`/`seri logout` — so a pty test can fake the device flow here exactly
// the way argv.test.ts already fakes it there. Every recompute-and-dispatch is wrapped so a failure
// (a network error, a denied/expired device code, a bad WorkOS client id) degrades to a rendered
// `auth-step` result rather than an unhandled rejection out of onSubmit's own fire-and-forget
// caller (InputBox's own useInput handler) — the same "never throw/crash" contract dispatchSetupList
// already has, just landing on `auth-step`/result instead of a bare command-error, since login/logout
// are a blocking panel (pendingAuth), not a list this file can just re-show.
export function createAuthHandlers(opts: {
  dispatch: Dispatch;
  // Pick, not the full CliDeps: this factory only ever reads these two injection seams, and naming
  // them here documents the actual contract instead of overstating it with cli.ts's ~20-field deps
  // bag (any CliDeps value still satisfies this — every caller keeps passing its own `deps` as-is).
  deps: Pick<CliDeps, "login" | "logout">;
  configDir: string;
}): {
  onLogin: (mode: "login" | "signup") => Promise<void>;
  onLogout: () => void;
  onAbandon: () => void;
} {
  const { dispatch, deps, configDir } = opts;
  const loginFn = deps.login ?? loginReal;
  const logoutFn = deps.logout ?? logoutReal;
  // Bug fix (thermo-nuclear, round 5): `attemptCounter` alone (round 4) only muted a dismissed
  // attempt's own DISPATCHES — the underlying login() kept polling in the background regardless
  // (a device code stays valid for minutes) and could still call saveAuthSession later, with zero
  // UI trace since the dispatches were suppressed; worse, past even an explicit /logout, since
  // nothing else stopped it either. `currentController` is real cancellation: `onAbandon` aborts
  // it, `pollForToken` (deviceFlow.ts) actually stops polling and returns `{status:"aborted"}`
  // instead of eventually succeeding unseen. `attemptCounter` stays too — it still correctly
  // guards the (much narrower, now purely UI-timing) dispatch race even with real cancellation
  // backing it up, mirroring cli.ts's own `turnInFlight`-style "ignore a stale async result"
  // pattern elsewhere.
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
        // Presentation only (this file's own header comment) — the state-machine dispatches
        // (auth-resolved, the auth-offer recompute) moved out to right after the `await` below,
        // run once rather than from inside a callback login() may or may not ever call.
        onMessage: (message) => {
          if (myAttempt !== attemptCounter) return;
          dispatch({ type: "transcript-append", line: message });
        },
        signal: controller.signal,
      });
      // Reached on a genuine success AND on an abort (login() returns normally either way — see
      // its own comment) — the guard is what tells them apart: an abort already bumped
      // `attemptCounter` (onAbandon) and already dispatched auth-resolved itself (onAuthResolved,
      // App.tsx), so this becomes a no-op rather than a second, redundant pair of dispatches.
      if (myAttempt !== attemptCounter) return;
      dispatch({ type: "auth-resolved" });
      dispatch({ type: "auth-offer", show: decideAuthOffer(configDir) });
    } catch (err) {
      if (myAttempt !== attemptCounter) return;
      dispatch({
        type: "auth-step",
        state: {
          step: "result",
          message: err instanceof Error ? err.message : String(err),
          error: true,
        },
      });
    }
  }

  // Sync, not async — logoutFn (typeof logoutReal) is fully synchronous; the call site already
  // just `await`s this either way, which works fine on a non-async function too.
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
          message: err instanceof Error ? err.message : String(err),
          error: true,
        },
      });
    }
    // One recompute either way (collapsed from two: a hardcoded `show: true` in the success path
    // and a recompute in the catch) — success or failure, this is the true current state, not an
    // assumption about which branch ran.
    dispatch({ type: "auth-offer", show: decideAuthOffer(configDir) });
  }

  // Real cancellation (see `currentController`'s own comment) plus the existing dispatch guard —
  // called from onAuthResolved (App.tsx) whenever the user dismisses "starting"/"device"/"result".
  function onAbandon(): void {
    attemptCounter += 1;
    currentController?.abort();
  }

  return { onLogin, onLogout, onAbandon };
}

// SERI_VERIFY_ENABLED and SERI_VERIFY_COMMAND are only ever read once, at prepareSession's own
// `loadVerifyConfig()` call (cli.ts), baked into `withVerification(...)` for the lifetime of the
// running process — unlike SERI_WORKOS_CLIENT_ID, which /login re-resolves live via
// getWorkosClientId on every attempt. `configKeyInfo`'s own `takesEffectNextRun` field (./commands)
// is what marks a key as one of these; this note is what keeps the confirmation honest about it.
function verifyConfigTakesEffectNote(key: string): string {
  return configKeyInfo(key).takesEffectNextRun ? " (takes effect on the next run)" : "";
}

// Stage D (cli-commands-to-tui feature-plan.md): /config's own two handlers, mirroring
// createSetupHandlers's exact shape (dispatch/getPendingConfig/configDir in). Calls the DATA
// functions directly — loadConfig/setConfigValue/unsetConfigValue (config/config.ts) — never
// configCommand (config/commands.ts), which is console/exit-code shaped for the non-interactive
// path. Every recompute-and-dispatch is wrapped in try/catch degrading to command-error: config.json
// can be hand-edited or corrupted mid-session, same reachable-anytime failure dispatchSetupList's
// own comment already documents for /setup.
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

  // Same "refresh the list, degrade to command-error" shape dispatchSetupList uses — and, like the
  // post-write refreshes below, closes the panel on that error rather than leaving `pendingConfig`
  // on whatever step it was: this is `onConfigBack`'s own refresh too, so a throwing
  // decideConfigOpen (a corrupted config.json) while sitting on confirm-unset used to leave that
  // step showing forever, since command-error alone never touches `pendingConfig`.
  function dispatchConfigList(selectedKey?: string): void {
    try {
      dispatch({ type: "config-step", state: configListState(selectedKey) });
    } catch (err) {
      dispatch({
        type: "command-error",
        message: err instanceof Error ? err.message : String(err),
      });
      dispatch({ type: "config-resolved" });
    }
  }

  // A boolean row toggles in place (write + transcript line + list refresh — a toggle has no
  // screen of its own, unlike enter-value); everything else opens the free-text entry step. `kind`
  // is static (configKeyInfo(key), a pure function of `key`) — no need to read it off the panel's
  // possibly-stale row, and doing so risked a silent wrong-branch fallback: if `pending` wasn't on
  // "list" or the row wasn't found, `row?.kind !== "boolean"` was vacuously true for a boolean key.
  function onConfigSelect(key: string): void {
    if (configKeyInfo(key).kind !== "boolean") {
      dispatch({ type: "config-step", state: { step: "enter-value", key, busy: false } });
      return;
    }
    let nextOn: boolean;
    try {
      // Toggles config.json's OWN stored value, not the effective (env-precedence-resolved) one —
      // a fresh disk read, not a possibly-stale `row.on`, so a concurrent write (another `seri`
      // process, a hand edit) between the list rendering and this call can't make the write
      // silently no-op while the transcript still claims a change. Same "re-check before acting"
      // reasoning as onConfigUnset's own confirm branch, just below. Toggling the EFFECTIVE value
      // instead would make every press a no-op under a truthy env var: config.json would keep
      // getting overwritten with the same value the env var was already forcing.
      nextOn = !configBoolean(loadConfig(configDir)[key]);
      setConfigValue(key, String(nextOn), configDir);
    } catch (err) {
      dispatch({
        type: "command-error",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    // The write above always lands in config.json, but a truthy env var wins the precedence race —
    // say so instead of claiming the active value changed.
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
          error: err instanceof Error ? err.message : String(err),
        },
      });
      return;
    }
    dispatch({
      type: "transcript-append",
      line: `Saved ${key}.${verifyConfigTakesEffectNote(key)}`,
    });
    // NOT dispatchConfigList (thermo-nuclear, round 3 — the stale version of this comment claimed
    // dispatchConfigList's catch leaves `pendingConfig` untouched, which stopped being true once
    // its catch started dispatching config-resolved): kept inline anyway, because closing the
    // panel here would be the wrong recovery — the user is mid-edit on a config.json write that
    // just wrote fine and only the REFRESH after it failed, so resetting `busy: false` and
    // showing the error on this same key lets them retry or Esc out, instead of losing the step
    // they were on for a failure in the read that happened after their write already succeeded.
    try {
      dispatch({ type: "config-step", state: configListState(key) });
    } catch (err) {
      dispatch({
        type: "config-step",
        state: {
          step: "enter-value",
          key,
          busy: false,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  // Dual-purpose (mirrors onSetupRemove's own comment): the SAME prop the list step's 'r'/Delete
  // and the confirm-unset step's 'y' both call — which one this call means is read off the CURRENT
  // live reducer state. The confirm branch reads `key` from `pending` itself, not the argument the
  // caller passed — same reasoning as onSetupRemove's own `pending.keyName`, not trusted from its
  // own `provider` argument either.
  function onConfigUnset(key: string): void {
    const pending = getPendingConfig();
    if (pending?.step === "confirm-unset") {
      const { key: confirmedKey } = pending;
      // Reviewer finding (round 1, LOW-4): unsetConfigValue's boolean return is checked, not
      // discarded — a concurrent write (another `seri` process, a hand edit) between the confirm
      // prompt opening and 'y' can already have removed this key, and this is what stops that race
      // from claiming "Removed" falsely.
      let removed: boolean;
      try {
        removed = unsetConfigValue(confirmedKey, configDir);
      } catch (err) {
        dispatch({
          type: "command-error",
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      dispatch({
        type: "transcript-append",
        line: removed
          ? `Removed ${confirmedKey}.${verifyConfigTakesEffectNote(confirmedKey)}`
          : `${confirmedKey} was not set.`,
      });
      dispatchConfigList(confirmedKey);
      return;
    }
    // Same reasoning as onSetupRemove's own re-check: ConfigList's own useInput already gated this
    // on `row.removable`, but that row can be stale (a concurrent /config write, another `seri`
    // process) — a fresh, guarded read is what actually decides whether to offer the confirm step.
    let hasConfigEntry: boolean;
    try {
      hasConfigEntry = Object.hasOwn(loadConfig(configDir), key);
    } catch (err) {
      dispatch({
        type: "command-error",
        message: err instanceof Error ? err.message : String(err),
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

// Stage D (cli-commands-to-tui feature-plan.md): /permissions' own two handlers, mirroring
// createConfigHandlers just above (itself mirroring createSetupHandlers). `permissionsDir`, not
// `configDir`: permissions.yaml lives in `ctx.permissionsDir` (RunContext's own field, `deps.
// permissionsDir ?? getConfigDir()` — independently overridable from config.json's own dir), the
// same directory runTurn's own approval-grant read/write (loadGrants/rememberGrant, cli.ts) already
// uses — reusing `configDir` here would read/write the wrong directory whenever a caller sets the
// two independently, exactly what this repo's own pty tests do. `getWorktree` is a closure, not a
// captured value, for the same "trust live state" reason `getPendingPermissions` is — runTui's own
// call site resolves it via checkpointTarget(liveState.session, dirs(ctx)), the exact pattern
// runTurn already uses.
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

  // /code-review, round 3: loadGrants never THROWS on a malformed permissions.yaml — it degrades
  // to an empty result and reports through this callback instead, which every call site in this
  // file was previously dropping (unlike decideConfigOpen's loadConfig, which does throw, so
  // /config's try/catch guards actually catch something). Without this, a malformed store
  // rendered as a silently-empty "nothing approved" panel instead of a visible error.
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

  // Same "refresh, and close the panel rather than leave it stuck" fix as dispatchConfigList's own
  // comment — `onPermissionsBack`'s own refresh, so a throw here used to leave `pendingPermissions`
  // on confirm-remove forever.
  function dispatchPermissionsList(selectedTool?: string): void {
    try {
      dispatch({ type: "permissions-step", state: permissionsListState(selectedTool) });
    } catch (err) {
      dispatch({
        type: "command-error",
        message: err instanceof Error ? err.message : String(err),
      });
      dispatch({ type: "permissions-resolved" });
    }
  }

  // Dual-purpose, same shape as onConfigUnset just above: the list step's 'r'/Delete and the
  // confirm-remove step's 'y' both call this prop. The confirm branch reads `tool` from `pending`
  // itself, not the argument the caller passed — same reasoning as onConfigUnset's own comment.
  function onPermissionsRemove(tool: string): void {
    const pending = getPendingPermissions();
    if (pending?.step === "confirm-remove") {
      const { tool: confirmedTool } = pending;
      // Reviewer finding (round 1, MEDIUM-2): loadGrants/forgetGrant do NOT throw on a malformed
      // permissions.yaml — they degrade to an empty/no-op result and an optional `onWarning`
      // callback instead (permissions/store.ts's own comment: the file is hand-editable, so a
      // caller must not risk overwriting content it could not make sense of). The non-interactive
      // removeCommand (permissions/commands.ts:68-91) already treats that as a real failure, not a
      // silent no-op — `warned` and the branch on `result` below mirror it, instead of
      // unconditionally claiming "Removed" the way this used to.
      //
      // scope: "project" (fixed here, /code-review + thermo-nuclear on this PR): a tool granted in
      // BOTH tiers still renders as a single "persisted"/removable row (decidePermissionsOpen,
      // tui/commands.ts) — the global grant is never shown, and `removable` just above only ever
      // checked the project tier. Passing "both" here used to strip the invisible global
      // pre-approval too, silently, on a panel whose own comment says only the project tier is
      // removable from here.
      // Hoisted, not called again below (thermo-nuclear, round 3): getWorktree() spawns a
      // synchronous `git rev-parse` — calling it three times in one keypress handler was three
      // subprocess spawns for a value that cannot change mid-handler.
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
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (warned !== undefined) {
        // Same "close the panel too" fix as dispatchPermissionsList's own comment (/code-review,
        // round 3): command-error alone never touches `pendingPermissions`, so a malformed
        // permissions.yaml discovered here (forgetGrant degrades to a warning rather than a throw)
        // used to leave the confirm-remove prompt stuck showing a tool that can no longer be
        // resolved from this state.
        dispatch({ type: "command-error", message: warned });
        dispatch({ type: "permissions-resolved" });
        return;
      }
      // Read unconditionally, not gated on `result.project` (thermo-nuclear, round 3): a
      // concurrent write between the `removable` re-check above and this 'y' press can already
      // have cleared the project entry by the time forgetGrant runs, independently of whether the
      // tool is still globally granted — gating this check on result.project made that race
      // report "was not permanently approved" even while the tool stayed auto-approved globally,
      // the exact false claim removeCommand's own comment (permissions/commands.ts:78-80) refuses
      // to make for the non-interactive path. Not try/catch-guarded, on purpose: loadGrants cannot
      // throw (store.ts's own readStore degrades every failure mode to a status instead), and this
      // file already carries guards on that call that can't fire — not adding another rather than
      // resolving the standing one.
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
    // Same reasoning as onConfigUnset's own re-check just above: PermissionsList's own useInput
    // already gated this on `row.removable`, but a fresh, guarded read is what actually decides —
    // only a project-tier (persisted) grant is removable from here.
    let removable: boolean;
    try {
      removable = loadGrants(permissionsDir, getWorktree(), warnOnMalformedStore).project.includes(
        tool,
      );
    } catch (err) {
      dispatch({
        type: "command-error",
        message: err instanceof Error ? err.message : String(err),
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
