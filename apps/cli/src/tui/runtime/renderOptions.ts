// The main TUI mount's own `createCliRenderer` config (`cli.ts`'s `runTui`, via `runtime/renderer.ts`).
import type { CliRendererConfig } from "@opentui/core";

// `exitOnCtrlC: false` — OpenTUI's own default (`exitOnCtrlC: true`) destroys the renderer itself
// on a bare Ctrl-C keypress, racing seri's own Ctrl-C route: signals.ts's single cancel slot,
// which the TUI's own `onCancel` prop reaches via `deliverSignal("SIGINT")`. Same reasoning
// Ink's `exitOnCtrlC: false` documented for the same reason.
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
// `alternateScreen` option; entered once for this renderer's own lifetime, matching Decision 1
// (docs/specs/025-tui-opentui-migration/spec.md): `routes/setup/welcomeSplash.ts`,
// `routes/setup/guidedSetup.ts`, and `runTui` (cli.ts) all share the one instance this config
// creates, so this is entered once for the whole splash -> setup -> main-TUI window, not per phase.
export const MAIN_TUI_RENDERER_CONFIG: CliRendererConfig = {
  exitOnCtrlC: false,
  exitSignals: [],
  screenMode: "alternate-screen",
};
