// Shared test fixtures for the TUI test suite — App.test.tsx's own originals, factored out once
// inputRenderCost.test.tsx needed near-identical `session`/`route`/`flush`, so a third file
// (inputThrottle.test.tsx) reusing `flush` doesn't have to re-derive it a third time either.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { TestRendererSetup } from "@opentui/core/testing";
import type { ModelCatalog, ModelCatalogEntry } from "@seri/model-catalog";
import type { ModelMessage } from "ai";
import type { ResolvedRoute } from "../../src/provider/routing";
import type { SessionState } from "../../src/session/session";

const CLI = pathToFileURL(join(import.meta.dir, "../../src/cli.ts")).href;

// SplashBanner.tsx's own MARK, the one-row mark the welcome splash opens on, and the handle every
// pty suite waits for before writing Escape to dismiss it. Matched rather than the "seri" wordmark
// beside it because the mark is a single text node and so arrives contiguous in the raw stream,
// where the wordmark is split from its version by the escapes between two nodes. Shared so a
// rename of the mark cannot leave one suite waiting on text nothing prints, which is what
// 32a1c8cc did.
export const SPLASH_MARK = "▁▁▄▄▄▁▁";

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
    credential: "key",
    ...overrides,
  };
}

// Structurally coupled to route()'s own defaults (id/provider), not just documented to match
// them, so a future change to route()'s default model or provider can't silently make a
// findCatalogEntry(catalog, route.model, route.provider) lookup miss without this fixture
// noticing too — both derive from the same source of truth.
export function catalogEntry(overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  const defaultRoute = route();
  return {
    id: defaultRoute.model,
    provider: defaultRoute.provider,
    displayName: "Claude Sonnet 5",
    family: "claude",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    toolCall: true,
    reasoning: true,
    pricing: undefined,
    ...overrides,
  };
}

export function catalogOf(entries: ModelCatalogEntry[]): ModelCatalog {
  return { fetchedAt: "2026-08-25T00:00:00.000Z", entries };
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
// the renderer's own SCHEDULER instead of sleeping a fixed time) don't apply here: tried directly
// against this exact scenario, `waitForFrame` times out — the renderer's scheduler reports itself
// idle (no running/rendering/scheduled-render state) before the markdown content tree is actually
// built, so there is no scheduler-visible signal that kind of helper could poll on.
// `@opentui/core`'s `CodeRenderable` exposes its own `highlightingDone` promise, but only for a
// fenced code block specifically, not through `MarkdownRenderable`'s own public surface, and most
// of this file's `flushMarkdown` call sites assert on plain prose with no code block at all.
// Instead of a fixed sleep — which broke 3 tests on a loaded Windows CI runner at 100ms, and would
// need bumping again on the next slower runner — this polls the caller's OWN completion signal (the
// captured frame's rendered TEXT, not the scheduler) on a short real interval up to a generous
// deadline: fast on a quiet machine (returns the moment the content appears), and scales to however
// slow a runner actually is instead of guessing a fixed margin for it up front.
export async function flushMarkdown(
  setup: TestRendererSetup,
  isSettled: (frame: string) => boolean,
): Promise<void> {
  // 3000ms, not bun:test's own 5000ms default per-test timeout: every call site here runs after a
  // `connect()`/`flush()` setup that already consumes some of that 5000ms budget, so a deadline
  // equal to (or close to) it would let bun's own timeout fire first — silently swallowing the throw
  // below and reporting a generic "test timed out" instead of the actual, more useful reason.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await setup.renderOnce();
    if (isSettled(setup.captureCharFrame())) return;
  }
  // Fails loudly here rather than letting the caller's own assertion fail against a plausible-but-
  // unsettled frame — the two look identical to whoever reads the failure, but only one of them
  // means "the markdown build never finished."
  throw new Error("flushMarkdown: content never settled within 3000ms");
}

// `waitForFrame` returns on the first capture that matches, and it also stops when the renderer
// scheduler reports idle — both of which fire while sticky-scroll is still painting. A later
// capture then disagrees with the drag, which is the rotating failure in transcriptSelection.
// Two identical captures are not enough: macOS CI painted the parked tail while hit-testing
// still used an earlier scrollTop, so a one-row drag copied four entries. Frame plus scrollTop
// must hold for three polls, the same real-time interval flushMarkdown uses.
export async function waitForSettledFrame(
  setup: TestRendererSetup,
  isSettled: (frame: string) => boolean,
): Promise<string> {
  const deadline = Date.now() + 3000;
  let previous: string | undefined;
  let previousScroll: number | undefined;
  let held = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    const [child] = setup.renderer.root.getChildren();
    const scrollTop =
      child !== undefined && "scrollTop" in child ? (child as { scrollTop: number }).scrollTop : 0;
    if (isSettled(frame) && frame === previous && scrollTop === previousScroll) {
      held++;
      if (held >= 2) return frame;
    } else {
      held = 0;
    }
    previous = frame;
    previousScroll = scrollTop;
  }
  throw new Error("waitForSettledFrame: content never settled within 3000ms");
}

// Shared between tuiPty.test.ts (real pty, POSIX) and tuiPtyWindows.test.ts (real ConPTY,
// Windows) — a runLoop that never settles, so the TUI stays mounted and interactive for as long
// as a test needs to type into it. Both suites need byte-identical child-process behavior for
// their own cross-platform comparisons to mean anything, so this has exactly one definition
// rather than two that could silently drift apart.
export function childScriptInput(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  await new Promise(() => {});`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}
