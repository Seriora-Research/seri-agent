// The main TUI mount's own `createCliRenderer` config (`cli.ts`'s `runTui`, via `runtime/renderer.ts`),
// and the one setting that has to be applied to the renderer after it exists rather than through
// that config (`applyTuiBackground`, below).
import type { CliRenderer, CliRendererConfig } from "@opentui/core";
import { configValue, loadConfig, tuiBackgroundColor } from "../../config/config";

// `exitOnCtrlC: false` — OpenTUI's own default (`exitOnCtrlC: true`) destroys the renderer itself
// on a bare Ctrl-C keypress, racing seri's own Ctrl-C route: signals.ts's single cancel slot,
// which `runtime/renderer.ts`'s own keypress registration reaches via `deliverSignal("SIGINT")`.
// Same reasoning Ink's `exitOnCtrlC: false` documented for the same reason.
//
// `exitSignals: []` — a DIFFERENT hazard than Ink ever had, found by reading
// `@opentui/core`'s own renderer source (its constructor calls `addExitListeners()`
// unconditionally): the default `exitSignals` list (`SIGINT`, `SIGTERM`, `SIGQUIT`, `SIGABRT`,
// `SIGHUP`, `SIGPIPE`, `SIGBREAK`, `SIGBUS`) registers a SECOND, competing `process.on(signal, ...)`
// handler for every one of those signals — seri already owns all of them via signals.ts
// (`onSignalCleanup`/`onSignalCleanupLast`/`raiseSignal`). An empty array is what actually skips
// `addExitListeners()` (its own guard is `this.exitSignals.length === 0`), not `undefined` (which
// falls back to that same competing default list).
//
// No `interactive`/CI-auto-detection override, unlike Ink's own `MAIN_TUI_RENDER_OPTIONS`: checked
// `@opentui/core`'s compiled source directly for any `process.env.CI`/`CONTINUOUS_INTEGRATION`
// read and found none. OpenTUI has no Ink-style "batch everything and print only the final frame
// when CI is set" behavior to override in the first place — seri's own `deps.isTTY` gate (`run()`'s
// `isTTY ? await runTui(...) : ...`) is still the only interactivity check that applies here.
//
// `screenMode: "alternate-screen"` — OpenTUI's renderer-level equivalent of Ink's per-mount
// `alternateScreen` option; entered once for this renderer's own lifetime: `routes/setup/
// welcomeSplash.ts`, `routes/setup/guidedSetup.ts`, and `runTui` (cli.ts) all share the one
// instance this config creates, so this is entered once for the whole splash -> setup -> main-TUI
// window, not per phase.
export const MAIN_TUI_RENDERER_CONFIG: CliRendererConfig = {
  exitOnCtrlC: false,
  exitSignals: [],
  screenMode: "alternate-screen",
};

// Opt-in: the TUI renders on whatever ground the terminal already has unless SERI_TUI_BACKGROUND
// names a `#rrggbb` color, because painting one breaks terminal transparency, background blur and
// theme matching for anyone who set those up on purpose (docs/design/tui.md).
//
// A `setBackgroundColor` call rather than a `backgroundColor` field on the config above:
// `@opentui/core` 0.5.6 declares `CliRendererConfig.backgroundColor` but its `CliRenderer`
// constructor never reads it — measured against the real class, a renderer built with
// `backgroundColor: "#141413"` still reports RGBA(0,0,0,0), byte-identical to one built with no
// background at all, and only the setter moves it. `runtime/renderer.ts` calls this between
// `createCliRenderer` and the first `root.render`, and nothing in `createCliRenderer` requests a
// render on the alternate-screen path, so the first frame the user sees already carries the ground.
export function applyTuiBackground(renderer: CliRenderer, configDir: string): void {
  const background = readTuiBackground(configDir);
  if (background !== undefined) renderer.setBackgroundColor(background);
}

// Guarded the way `routes/setup/welcomeSplash.ts` guards its own read: a corrupted config.json
// costs the user a background preference, not a launch.
function readTuiBackground(configDir: string): string | undefined {
  try {
    return tuiBackgroundColor(configValue("SERI_TUI_BACKGROUND", loadConfig(configDir)));
  } catch {
    return undefined;
  }
}
