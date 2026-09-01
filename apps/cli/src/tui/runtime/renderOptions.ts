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
//
// `useMouse: false` — OpenTUI's own default enables the maximal mouse-reporting set (`?1000` click,
// `?1002` cell-motion, `?1003` any-motion, `?1006` SGR coordinates), and a terminal reporting the
// mouse to an application no longer selects text for the user: for as long as seri runs, dragging
// across the transcript to grab a file path or an error selects nothing, and the alt-screen means
// the text is not in the scrollback afterwards either. This buys back the terminal's OWN selection
// and its own copy chord — which work over SSH, inside tmux, with nothing to detect and no OSC 52
// dependency — and pays for it with the four affordances OpenTUI gives the transcript scrollbox off
// that same reporting: wheel scroll, scrollbar thumb drag, click-to-focus, Shift+wheel. seri
// authors no mouse handling of its own (no `onMouseDown`/`onClick` anywhere under `tui/`), so
// nothing else in the app notices they are gone. Not a door that closes: OpenTUI's own
// `renderer.useMouse` setter re-emits the enable/disable sequences on the same tick, so a future
// surface that genuinely needs the mouse turns reporting on for its own lifetime and off again
// after. docs/specs/044-tui-selection-copy/research.md measures the trade and prices what it costs
// the transcript — `runtime/renderer.ts`'s own `?1007` suppression and app.tsx's approval-paging
// gate and hidden scrollbar are the rest of that price, not separate concerns.
export const MAIN_TUI_RENDERER_CONFIG: CliRendererConfig = {
  exitOnCtrlC: false,
  exitSignals: [],
  screenMode: "alternate-screen",
  useMouse: false,
};

// Default paper `#141413` (docs/design/tui.md): the border and user-band tokens were sampled
// against this ground, and an unset preference now paints it. `SERI_TUI_BACKGROUND=terminal`
// (or any non-hex) restores the previous leave-alone path, because painting a ground still
// breaks terminal transparency, background blur and theme matching for anyone who set those
// up on purpose.
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
    const raw = configValue("SERI_TUI_BACKGROUND", loadConfig(configDir));
    if (raw === undefined) return "#141413";
    return tuiBackgroundColor(raw);
  } catch {
    return undefined;
  }
}
