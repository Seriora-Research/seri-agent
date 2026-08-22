// Shared test fixtures for the TUI test suite — App.test.tsx's own originals, factored out once
// inputRenderCost.test.tsx needed near-identical `session`/`route`/`flush`, so a third file
// (inputThrottle.test.tsx) reusing `flush` doesn't have to re-derive it a third time either.

import type { TestRendererSetup } from "@opentui/core/testing";
import type { ModelMessage } from "ai";
import type { ResolvedRoute } from "../../src/provider/routing";
import type { SessionState } from "../../src/session/session";

export function session(
  overrides: Partial<SessionState<ModelMessage>> = {},
): SessionState<ModelMessage> {
  return {
    id: "s1",
    cwd: "/repo",
    systemPrompt: "",
    permissionMode: "approve-each",
    messages: [],
    ...overrides,
  };
}

// AppProps.route is required (D3's own invariant: a PreparedRun cannot exist without a resolved
// route) — every <App> mount needs one, not just a test that cares about its rendered content.
export function route(overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return {
    model: "claude-sonnet-5",
    provider: "anthropic",
    rerouted: false,
    viaGateway: false,
    ...overrides,
  };
}

// @opentui/react's reconciler commits on a macrotask, not a microtask (verified independently
// against this exact harness) — a plain render/dispatch needs a
// real timer tick before `renderOnce()`/`captureCharFrame()` reliably observes the committed
// result, and a component that just (re)mounted (a panel swap, or the initial mount) needs a
// SECOND settled pass before its own passive effects (`useKeyboard`/`usePaste`'s `useEffect`)
// actually subscribe — a single pass left a fresh mount's own keyboard handler unregistered.
// `flush` runs both passes on every call rather than track "did anything actually (re)mount this
// tick" per call site: the second pass is a no-op cost (nothing new to subscribe) when nothing did,
// and every call site in this suite dispatches into a tree that may or may not have just swapped a
// panel, so a caller can't cheaply know in advance which case it is.
export async function flush(setup: TestRendererSetup): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await setup.renderOnce();
  }
}
