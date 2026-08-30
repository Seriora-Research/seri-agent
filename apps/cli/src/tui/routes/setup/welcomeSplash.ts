// Renders first inside the one consolidated `CliRenderer` (`runtime/renderer.ts`'s
// `getTuiRenderer`, shared with `guidedSetup.ts` and `runTui`, cli.ts) — the welcome splash that
// shows ahead of both the zero-key guided-setup gate and the normal TUI on every interactive
// launch (`run()`'s own call site). `getTuiRenderer` is idempotent, so this is the call that
// actually creates the renderer for the whole splash -> setup -> main-TUI sequence; `guidedSetup.ts`
// and `runTui` reuse the same instance and simply `root.render` different content, rather than each
// owning a separate mount. Reuses `createAuthHandlers` (./handlers) — the same device-flow auth
// wiring `runTui` reuses, rather than a second implementation of it.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { createElement } from "react";
import pkg from "../../../../package.json";
import type { CliDeps } from "../../../cli";
import { loadConfig } from "../../../config/config";
import { DEFAULT_PROVIDER, resolveDefaultModel } from "../../../provider/defaults";
import { DEFAULT_MODEL } from "../../../provider/groq";
import { App } from "../../app";
import { getTuiRenderer } from "../../runtime/renderer";
import { decideAuthOffer } from "../../state/commands";
import { createAuthHandlers } from "../../state/handlers";
import { type Dispatch, initialTuiState, type TuiState, tuiReducer } from "../../state/reducer";

export async function runWelcomeSplash(
  configDir: string,
  deps: CliDeps,
  // Forwarded straight to App, never stored here: this mount stays on screen after this
  // function's own promise resolves — `run()` only replaces it once `prepareSession` is done —
  // so a task typed in that window arrives AFTER the await below has already returned.
  onPreSessionSubmit: (task: string) => void,
): Promise<void> {
  const { root } = await getTuiRenderer();

  // Same synchronous-mirror pattern as guidedSetup.ts's own liveState/dispatch — see that file's
  // own comment for why a caller reading state right after a dispatch needs this rather than
  // React's own effect-scheduled commit.
  let liveState: TuiState = initialTuiState(
    {
      id: randomUUID(),
      cwd: process.cwd(),
      systemPrompt: "",
      permissionMode: "approve-each",
      messages: [],
    },
    { showSplash: true },
  );
  let reactDispatch: Dispatch | undefined;
  const dispatch: Dispatch = (action) => {
    liveState = tuiReducer(liveState, action);
    reactDispatch?.(action);
  };

  const { onLogin, onAbandon } = createAuthHandlers({ dispatch, deps, configDir });

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  // createAuthHandlers' own onLogin never rejects (a failure dispatches an "auth-step"/"result"
  // instead) — awaited here, then `liveState.pendingAuth` (this mount's own synchronous mirror,
  // read fresh right after) is what tells a genuine success apart from a failure still on screen: a
  // SUCCESSFUL login dispatches "auth-resolved" itself (createAuthHandlers' own catch-free path)
  // with no further keypress ever coming, which — unlike runTui's mount, where that same dispatch
  // just reveals the InputBox already wired to a live session — would otherwise leave this phase's
  // own `closed` promise permanently unresolved, since only onSplashContinue/onAuthResolved
  // (dismissing a still-open panel) call `resolveClosed` here. A failure leaves `pendingAuth` set
  // (the "result" step), so it stays on screen for the user to read and dismiss via onAuthResolved,
  // same as today.
  async function onSplashLogin(): Promise<void> {
    dispatch({ type: "splash-resolved" });
    await onLogin("login");
    if (liveState.pendingAuth === undefined) resolveClosed();
  }

  async function onSplashSignup(): Promise<void> {
    dispatch({ type: "splash-resolved" });
    await onLogin("signup");
    if (liveState.pendingAuth === undefined) resolveClosed();
  }

  function onSplashContinue(): void {
    dispatch({ type: "splash-resolved" });
    resolveClosed();
  }

  // Unlike runTui's own onAuthResolved, dismissing the auth panel here always ends this phase —
  // there is no InputBox to return to in a throwaway pre-session screen.
  function onAuthResolved(): void {
    onAbandon();
    dispatch({ type: "auth-resolved" });
    resolveClosed();
  }

  // Unlike route/catalog (this phase never has a PreparedRun to give them), config.json IS
  // available here — guarded so a corrupted config.json can't crash the splash mount; it just
  // means the header shows no config-derived tier, same as the `{}` every other mount before a
  // real read fires here would already show.
  let initialConfig: Record<string, string>;
  try {
    initialConfig = loadConfig(configDir);
  } catch {
    initialConfig = {};
  }

  // The banner's model row (SplashBanner.tsx). Its own guard, not folded into the one above:
  // `resolveDefaultModel` reads env FIRST, so a corrupted config.json still leaves a
  // `SERI_MODEL=… seri` launch reporting the right pair, and one shared try would throw that away.
  // `provider` is `undefined` when nothing named one; `DEFAULT_PROVIDER` is what routing itself
  // applies then, so the row names what the first turn will dispatch to rather than a blank.
  let defaultModel: ReturnType<typeof resolveDefaultModel>;
  try {
    defaultModel = resolveDefaultModel(configDir);
  } catch {
    defaultModel = { model: DEFAULT_MODEL, provider: undefined };
  }

  root.render(
    createElement(App, {
      session: liveState.session,
      route: undefined,
      catalog: undefined, // no PreparedRun exists yet at this point in startup
      config: initialConfig,
      splashBanner: {
        version: pkg.version,
        model: defaultModel.model,
        provider: defaultModel.provider ?? DEFAULT_PROVIDER,
        cwd: process.cwd(),
        // `process.env.HOME || homedir()`, the same order config/paths.ts resolves the seri root
        // with — so a HOME override that moves the config directory also moves what this row
        // abbreviates, instead of the two disagreeing about where home is.
        home: process.env.HOME || homedir(),
      },
      onPreSessionSubmit,
      onSplashLogin,
      onSplashSignup,
      onSplashContinue,
      onAuthResolved,
      connectDispatch: (reducerDispatch: Dispatch) => {
        reactDispatch = reducerDispatch;
        // App's own internal `useReducer(tuiReducer, initialTuiState(session))` call never sees
        // this phase's `showSplash` opt (that only seeds `liveState`, above) — `splash-requested`
        // is what actually flips App's OWN rendered `pendingSplash` to true, the same "requested"
        // dispatch every other pending panel already fires from its own connectDispatch.
        dispatch({ type: "splash-requested" });
        dispatch({ type: "auth-offer", show: decideAuthOffer(configDir) });
      },
    }),
  );

  // No `onSignalCleanup`/unmount registration here: `getTuiRenderer` already registers the
  // renderer's own destroy as the process's lastCleanup (runtime/renderer.ts), once, for the whole
  // splash -> setup -> main-TUI window this call created — a fatal signal at any point in that
  // window is already covered without a second, per-phase registration.
  await closed;
}
