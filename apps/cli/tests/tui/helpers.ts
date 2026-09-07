import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { TestRendererSetup } from "@opentui/core/testing";
import type { ModelCatalog, ModelCatalogEntry } from "@seri/model-catalog";
import type { ModelMessage } from "ai";
import type { ResolvedRoute } from "../../src/provider/routing";
import type { SessionState } from "../../src/session/session";

const CLI = pathToFileURL(join(import.meta.dir, "../../src/cli.ts")).href;

// SplashBanner MARK is one contiguous pty node; the "seri" wordmark splits across escapes, which is what 32a1c8cc hung on.
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

export function route(overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return {
    model: "claude-sonnet-5",
    provider: "anthropic",
    rerouted: false,
    credential: "key",
    ...overrides,
  };
}

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

// @opentui/react commits on a macrotask and useKeyboard/usePaste subscribe from a passive useEffect, so two renderOnce passes are required before a fresh mount sees keys.
export async function flush(setup: TestRendererSetup): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await setup.renderOnce();
  }
}

// MarkdownRenderable builds on real elapsed time; OpenTUI waitForFrame reports idle first, and a fixed 100ms sleep failed on loaded Windows CI, so this polls frame text up to 3000ms.
export async function flushMarkdown(
  setup: TestRendererSetup,
  isSettled: (frame: string) => boolean,
): Promise<void> {
  // 3000ms so bun's 5000ms test timeout can still surface this throw after connect()/flush() setup.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await setup.renderOnce();
    if (isSettled(setup.captureCharFrame())) return;
  }
  throw new Error("flushMarkdown: content never settled within 3000ms");
}

// waitForFrame and a matching capture both fire while sticky-scroll is still painting; macOS CI copied four entries from a one-row drag unless frame plus scrollTop hold for three 20ms polls.
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

// Shared POSIX pty and Windows ConPTY child so both suites compare byte-identical processes.
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
