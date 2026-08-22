// The one `CliRenderer` instance spanning welcome-splash -> guided-setup -> main-TUI (Decision 1,
// docs/specs/025-tui-opentui-migration/spec.md), replacing Ink's per-mount `render`/
// `instance.rerender`/`instance.unmount`/`instance.waitUntilExit` calls. `getTuiRenderer` is
// idempotent (below), so `routes/setup/welcomeSplash.ts` — the first of the three callers,
// cli.ts's own `run()` — is what actually creates it; `routes/setup/guidedSetup.ts` and `runTui`
// (cli.ts) reuse the same instance and `root.render` different content into it rather than each
// owning a separate mount.
import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { createRoot, type Root } from "@opentui/react";
import { onSignalCleanupLast } from "../../signals";
import { MAIN_TUI_RENDERER_CONFIG } from "./renderOptions";

let instance: { renderer: CliRenderer; root: Root } | undefined;

// Idempotent: three call sites share this instance today (see this file's own header comment),
// so this stays safe to call more than once (returns the same instance) rather than assuming a
// single caller.
export async function getTuiRenderer(): Promise<{ renderer: CliRenderer; root: Root }> {
  if (instance !== undefined) return instance;
  const renderer = await createCliRenderer(MAIN_TUI_RENDERER_CONFIG);
  const root = createRoot(renderer);
  instance = { renderer, root };
  // Registered once, at creation, so a fatal signal that arrives at any point across the whole
  // splash -> setup -> main-TUI window still restores the terminal (raw mode, alt-screen, cursor
  // visibility) rather than leaving it corrupted.
  onSignalCleanupLast(() => instance?.renderer.destroy());
  return instance;
}

// No-op if `getTuiRenderer` was never called — a fatal bailout before `runWelcomeSplash` ever
// creates the renderer must still be safe to call this.
export function destroyTuiRenderer(): void {
  if (instance === undefined) return;
  instance.renderer.destroy();
  instance = undefined;
}
