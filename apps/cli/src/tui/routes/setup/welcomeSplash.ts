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
  onPreSessionSubmit: (task: string) => void,
): Promise<void> {
  const { root } = await getTuiRenderer(configDir);

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

  function onAuthResolved(): void {
    onAbandon();
    dispatch({ type: "auth-resolved" });
    resolveClosed();
  }

  let initialConfig: Record<string, string>;
  try {
    initialConfig = loadConfig(configDir);
  } catch {
    initialConfig = {};
  }

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
      catalog: undefined,
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
        dispatch({ type: "splash-requested" });
        dispatch({ type: "auth-offer", show: offerAuth });
      },
    }),
  );

  await closed;
}
