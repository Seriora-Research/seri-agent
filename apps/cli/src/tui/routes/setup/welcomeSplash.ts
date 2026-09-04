// Renders first inside the one consolidated `CliRenderer` (`runtime/renderer.ts`'s
// `getTuiRenderer`, shared with `guidedSetup.ts` and `runTui`, cli.ts) — the welcome splash that
// shows ahead of both the zero-key guided-setup gate and the normal TUI on every interactive
// launch (`run()`'s own call site). `getTuiRenderer` is idempotent, so this is the call that
// actually creates the renderer for the whole splash -> setup -> main-TUI sequence; `guidedSetup.ts`
// and `runTui` reuse the same instance and simply `root.render` different content, rather than each
// owning a separate mount. Reuses `createAuthHandlers` (./handlers) — the same device-flow auth
// wiring `runTui` reuses, rather than a second implementation of it.
import { randomUUID } from "node:crypto";
import { resolveUserHome } from "../../../config/userHome";
import { createElement } from "react";
import pkg from "../../../../package.json";
import type { CliDeps } from "../../../cli";
import { loadConfig } from "../../../config/config";
import { hostedPlanUsable } from "../../../auth/seriIgnore";
import { DEFAULT_PROVIDER, resolveDefaultModel } from "../../../provider/defaults";
import { DEFAULT_MODEL } from "../../../provider/groq";
import { configuredProviders } from "../../../provider/keys";
import { GATEWAY_PROVIDER } from "../../../provider/planCoverage";
import { subscribedProviders } from "../../../provider/subscriptions";
import { App } from "../../app";
import { getTuiRenderer } from "../../runtime/renderer";
import { decideAuthOffer } from "../../state/commands";
import { createAuthHandlers } from "../../state/handlers";
import { type Dispatch, initialTuiState, type TuiState, tuiReducer } from "../../state/reducer";
import { formatRouteLabel } from "../../util/format";

export async function runWelcomeSplash(
  configDir: string,
  deps: CliDeps,
  // Forwarded straight to App, never stored here: this mount stays on screen after this
  // function's own promise resolves — `run()` only replaces it once `prepareSession` is done —
  // so a task typed in that window arrives AFTER the await below has already returned.
  onPreSessionSubmit: (task: string) => void,
): Promise<void> {
  const { root } = await getTuiRenderer(configDir);

  // Same synchronous-mirror pattern as guidedSetup.ts's own liveState/dispatch — see that file's
  // own comment for why a caller reading state right after a dispatch needs this rather than
  // React's own effect-scheduled commit.
  // Computed before the first render so App's reducer can seed `authOffer` the same way
  // `showSplash` seeds `pendingSplash`. `connectDispatch` still dispatches both actions, but
  // those effects run after the first commit and cannot win the first paint.
  const offerAuth = decideAuthOffer(configDir);

  let liveState: TuiState = initialTuiState(
    {
      id: randomUUID(),
      cwd: process.cwd(),
      systemPrompt: "",
      permissionMode: "approve-each",
      messages: [],
    },
    { showSplash: true, authOffer: offerAuth },
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

  const provider = defaultModel.provider ?? DEFAULT_PROVIDER;
  const configured = configuredProviders(configDir);
  const subscribed = subscribedProviders(configDir);
  const hosted = hostedPlanUsable(configDir);
  const via = formatRouteLabel({
    keyConfigured: configured.has(provider),
    subscriptionCovered: subscribed.has(provider),
    gatewayReachable:
      hosted &&
      !subscribed.has(provider) &&
      (!configured.has(provider) || provider === GATEWAY_PROVIDER),
    provider,
  });

  root.render(
    createElement(App, {
      session: liveState.session,
      route: undefined,
      catalog: undefined, // no PreparedRun exists yet at this point in startup
      config: initialConfig,
      splashBanner: {
        version: pkg.version,
        model: defaultModel.model,
        provider,
        via,
        cwd: process.cwd(),
        home: resolveUserHome(),
      },
      onPreSessionSubmit,
      showSplash: true,
      authOffer: offerAuth,
      onSplashLogin,
      onSplashSignup,
      onSplashContinue,
      onAuthResolved,
      connectDispatch: (reducerDispatch: Dispatch) => {
        reactDispatch = reducerDispatch;
        // Same values already seeded on the initializer. Re-dispatching after the first paint is
        // a no-op visually (`pendingSplash`/`authOffer` are already true) and keeps this mount's
        // connectDispatch on the same "requested at mount" shape every other pending panel uses.
        dispatch({ type: "splash-requested" });
        dispatch({ type: "auth-offer", show: offerAuth });
      },
    }),
  );

  // No `onSignalCleanup`/unmount registration here: `getTuiRenderer` already registers the
  // renderer's own destroy as the process's lastCleanup (runtime/renderer.ts), once, for the whole
  // splash -> setup -> main-TUI window this call created — a fatal signal at any point in that
  // window is already covered without a second, per-phase registration.
  await closed;
}
