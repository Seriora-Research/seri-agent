// Mirrors guidedSetup.ts's own mount structure (throwaway session, liveState/dispatch synchronous
// mirror, render()/instance.unmount(), onSignalCleanup) for a single, separate, earlier Ink mount:
// the welcome splash that shows ahead of both the zero-key guided-setup gate and the normal TUI on
// every interactive launch (run()'s own call site). Unlike guidedSetup.ts, this file does import
// from cli.ts (createAuthHandlers, CliDeps) — the same device-flow auth wiring runTui reuses,
// rather than a second implementation of it.
import { randomUUID } from "node:crypto";
import { type CliDeps, createAuthHandlers } from "../cli";
import { deliverSignal, onSignalCleanup } from "../signals";
import { decideAuthOffer } from "./commands";
import { type Dispatch, initialTuiState, type TuiState, tuiReducer } from "./reducer";

export async function runWelcomeSplash(configDir: string, deps: CliDeps): Promise<void> {
  const { render } = await import("ink");
  const { createElement } = await import("react");
  const { App } = await import("./App");

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

  function onSplashLogin(): void {
    dispatch({ type: "splash-resolved" });
    onLogin("login");
  }

  function onSplashSignup(): void {
    dispatch({ type: "splash-resolved" });
    onLogin("signup");
  }

  function onSplashContinue(): void {
    dispatch({ type: "splash-resolved" });
    resolveClosed();
  }

  // Unlike runTui's own onAuthResolved, dismissing the auth panel here always ends this mount —
  // there is no InputBox to return to in a throwaway pre-session screen.
  function onAuthResolved(): void {
    onAbandon();
    dispatch({ type: "auth-resolved" });
    resolveClosed();
  }

  const instance = render(
    createElement(App, {
      session: liveState.session,
      route: undefined,
      done: false,
      onCancel: () => deliverSignal("SIGINT"),
      onSplashLogin,
      onSplashSignup,
      onSplashContinue,
      onAuthResolved,
      connectDispatch: (reducerDispatch: Dispatch) => {
        reactDispatch = reducerDispatch;
        // App's own internal `useReducer(tuiReducer, initialTuiState(session))` call never sees
        // this mount's `showSplash` opt (that only seeds `liveState`, above) — `splash-requested`
        // is what actually flips App's OWN rendered `pendingSplash` to true, the same "requested"
        // dispatch every other pending panel already fires from its own connectDispatch.
        dispatch({ type: "splash-requested" });
        dispatch({ type: "auth-offer", show: decideAuthOffer(configDir) });
      },
    }),
    { exitOnCtrlC: false, interactive: true },
  );

  onSignalCleanup(() => instance.unmount());

  await closed;
  instance.unmount();
}
