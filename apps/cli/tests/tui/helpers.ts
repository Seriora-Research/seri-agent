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

// `<markdown>` (app.tsx's own assistant-entry render) settles its content-to-render-tree build on
// a REAL elapsed-time delay, not just a settled macrotask — verified empirically: 30 rapid
// zero-delay `flush()`-style passes (tens of real milliseconds total) still render nothing, while a
// real wait reliably does. Every other renderable in this suite settles within `flush()`'s own
// fast passes; only a test asserting on assistant/markdown-rendered content needs this instead.
// `TestRendererSetup`'s own `waitForFrame`/`waitForVisualIdle` (settle-condition helpers that poll
// the renderer's scheduler instead of sleeping a fixed time) don't apply here: tried directly
// against this exact scenario, `waitForFrame` times out — the renderer's scheduler reports itself
// idle (no running/rendering/scheduled-render state) before the markdown content tree is actually
// built, so there is no scheduler-visible signal a settle-condition helper could poll on.
// `@opentui/core`'s `CodeRenderable` exposes its own `highlightingDone` promise, but only for a
// fenced code block specifically, not through `MarkdownRenderable`'s own public surface, and three
// of this file's four `flushMarkdown` call sites assert on plain prose with no code block at all —
// a real elapsed-time wait is the only mechanism that covers all of them. 300ms, not the 100ms
// this margin first shipped with: a loaded CI runner (observed on a Windows runner specifically)
// doesn't finish the build inside 100ms as reliably as a quiet dev machine does.
export async function flushMarkdown(setup: TestRendererSetup): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await setup.renderOnce();
}
