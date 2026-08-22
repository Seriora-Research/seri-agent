// The one `CliRenderer` instance spanning welcome-splash -> guided-setup -> main-TUI (Decision 1,
// docs/specs/025-tui-opentui-migration/spec.md), replacing Ink's per-mount `render`/
// `instance.rerender`/`instance.unmount`/`instance.waitUntilExit` calls. `getTuiRenderer` is
// idempotent (below), so `routes/setup/welcomeSplash.ts` — the first of the three callers,
// cli.ts's own `run()` — is what actually creates it; `routes/setup/guidedSetup.ts` and `runTui`
// (cli.ts) reuse the same instance and `root.render` different content into it rather than each
// owning a separate mount.
import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { createRoot, type Root } from "@opentui/react";
import { deliverSignal, onSignalCleanupLast } from "../../signals";
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
  // Registered once here, directly on the renderer's own key input, rather than via `<App>`'s own
  // `useKeyboard` (every call site used to pass an identical `onCancel: () => deliverSignal("SIGINT")`
  // prop for exactly this). Measured: each of `root.render`'s three splash/setup/main-TUI calls
  // (welcomeSplash.ts, guidedSetup.ts, cli.ts) mounts a fresh `<App>` at the same root, and its
  // Ctrl-C `useKeyboard` listener from an earlier phase does not always get cleaned up before the
  // next one mounts — by the time the main TUI phase is interactive, more than one of these listeners
  // can be attached at once, so a single physical Ctrl-C calls `deliverSignal` more than once: the
  // first call spends signals.ts's one cancel slot as intended, but the second call in the same tick
  // finds the slot already empty and falls through to the fatal path, destroying this renderer
  // instead of just cancelling the turn. A single registration tied to the renderer's own lifetime,
  // not to any particular React mount, cannot double-fire this way.
  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.name === "c") deliverSignal("SIGINT");
  });
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
