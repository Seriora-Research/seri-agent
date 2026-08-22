// `runTui`'s own OpenTUI mount (`cli.ts`), replacing Ink's `render`/`instance.rerender`/
// `instance.unmount`/`instance.waitUntilExit` calls. Decision 1 (docs/specs/025-tui-opentui-migration
// /spec.md) is ONE `CliRenderer` instance spanning welcome-splash -> guided-setup -> main-TUI; this
// module only covers the main-TUI leg for now (`welcomeSplash.ts`/`guidedSetup.ts` still mount
// their own separate ink renders — a later migration dispatch's job) — see
// `runtime/legacyAltScreen.ts`'s own header comment for how the two coexist in the meantime.
import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { createRoot, type Root } from "@opentui/react";
import { onSignalCleanupLast } from "../../signals";
import { MAIN_TUI_RENDERER_CONFIG } from "./renderOptions";

let instance: { renderer: CliRenderer; root: Root } | undefined;

// Idempotent: `runTui` is the only caller today, but this stays safe to call more than once
// (returns the same instance) rather than assuming a single call site, the same way
// `runtime/legacyAltScreen.ts`'s own `entered` guard does for the same reason.
export async function getTuiRenderer(): Promise<{ renderer: CliRenderer; root: Root }> {
  if (instance !== undefined) return instance;
  const renderer = await createCliRenderer(MAIN_TUI_RENDERER_CONFIG);
  const root = createRoot(renderer);
  instance = { renderer, root };
  // Mirrors `runtime/legacyAltScreen.ts`'s own registration comment: registered once, at creation,
  // so a fatal signal that arrives before `destroyTuiRenderer` ever runs still restores the
  // terminal (raw mode, alt-screen, cursor visibility) rather than leaving it corrupted.
  onSignalCleanupLast(() => instance?.renderer.destroy());
  return instance;
}

// No-op if `getTuiRenderer` was never called (mirrors `exitAltScreen`'s own `if (!entered) return`
// guard) — a fatal bailout before `runTui` ever mounts must still be safe to call this.
export function destroyTuiRenderer(): void {
  if (instance === undefined) return;
  instance.renderer.destroy();
  instance = undefined;
}
