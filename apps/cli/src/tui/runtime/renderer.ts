// The one `CliRenderer` instance spanning welcome-splash -> guided-setup -> main-TUI, replacing
// Ink's per-mount `render`/`instance.rerender`/`instance.unmount`/`instance.waitUntilExit` calls.
// `getTuiRenderer` is idempotent (below), so `routes/setup/welcomeSplash.ts` — the first of the
// three callers, cli.ts's own `run()` — is what actually creates it; `routes/setup/guidedSetup.ts`
// and `runTui` (cli.ts) reuse the same instance and `root.render` different content into it rather
// than each owning a separate mount.
import { writeSync } from "node:fs";
import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { createRoot, type Root } from "@opentui/react";
import { messageOf } from "../../errors";
import { deliverSignal, onSignalCleanupLast } from "../../signals";
import { applyTuiBackground, MAIN_TUI_RENDERER_CONFIG } from "./renderOptions";

let instance: { renderer: CliRenderer; root: Root } | undefined;

// Alternate scroll (DECSET 1007) is what a terminal does with the wheel while an application is in
// the alternate screen and is NOT tracking the mouse: it translates every notch into arrow
// keypresses. `renderOptions.ts`'s own `useMouse: false` is precisely what puts seri in that state,
// and the translation is the documented default on Windows Terminal, VTE/GNOME Terminal, WezTerm
// and Alacritty — so the wheel does not go quiet when reporting stops, it starts typing.
//
// Those arrows are not harmless here. Driven over a real pty they walk an open panel's list
// selection, they cycle the completion popup, and on an empty input with any subagent live a bare
// Down dispatches `subagent-panel-focus` (InputBox.tsx's own `onEmptyDown`) — a scroll gesture
// stealing focus into the roster. They are inert only when the app is idle with no panel and no
// subagents. Routing them to the transcript instead is not available as a fix: a translated notch
// and a real arrow key arrive as the identical bytes, so nothing downstream can tell them apart.
//
// SAVE then disable, and RESTORE on the way out — never `?1007h`. The mode's default differs per
// terminal (on for Windows Terminal, off for xterm), so re-enabling it unconditionally at exit
// would leave the user's terminal in a state seri invented, outliving the process. Written straight
// to fd 1 rather than through the renderer: OpenTUI only takes ownership of `stdout.write` under
// `screenMode: "split-footer"` (its `capture-stdout` external-output mode) and `renderOptions.ts`
// pins `"alternate-screen"`, so this IS the same underlying stream OpenTUI's own output falls back
// to; these are complete, self-contained CSI mode sets that OpenTUI itself never emits for either
// value, so there is no sequence of its own to interleave with.
//
// `writeSync`, not `process.stdout.write`, and the restore is what makes that load-bearing: a write
// to a TTY is asynchronous on Windows, and every caller of the restore dies on its very next
// statement — the `uncaughtException`/`unhandledRejection` pair below calls `destroyTuiRenderer()`
// and then `process.exit(1)`, and the signal path runs its cleanup and then `process.kill`. Neither
// flushes a queued write, so the moment restoring the user's terminal matters most is exactly the
// moment an async one is dropped. The suppress goes through the same call so the pair cannot come
// apart. docs/specs/044-tui-selection-copy/research.md has the per-terminal table.
let alternateScrollSuppressed = false;

function suppressAlternateScroll(): void {
  writeSync(1, "\x1b[?1007s\x1b[?1007l");
  alternateScrollSuppressed = true;
}

// Both teardown paths below call this, and a fatal signal can arrive after an ordinary teardown has
// already run — whichever gets here first is the one that writes.
function restoreAlternateScroll(): void {
  if (!alternateScrollSuppressed) return;
  alternateScrollSuppressed = false;
  writeSync(1, "\x1b[?1007r");
}

// `@opentui/react`'s own `createRoot(renderer).render(node)` creates a BRAND NEW reconciler
// container on every call rather than reconciling into the previous one (confirmed by reading its
// compiled source) — so calling `.render()` again for the next phase does not run any of the
// previous tree's own effect cleanups; that tree's `useKeyboard`/`usePaste` listeners stay attached
// to the renderer's shared `keyInput` forever, alongside the new tree's own. Measured live over a
// real pty: past the welcome-splash -> main-TUI transition, a single physical PageDown fired
// app.tsx's own scroll handler twice — once from the live tree, once from the splash phase's own
// stale, disconnected `<App>` instance. The second firing dispatches into that stale instance's own
// abandoned `useReducer` state, whose render output no longer reaches the terminal (its host nodes
// were already removed when the live tree mounted), so this specific handler has no visible
// symptom today — but Ctrl-C's own handler (`renderer.keyInput.on("keypress", ...)` below) reaches
// OUTSIDE any one component's state into `signals.ts`'s module-level cancel slot, where a second,
// invisible-tree firing very much has a real, user-facing consequence (this is exactly the bug that
// registration used to have, before it moved off `<App>`'s own `useKeyboard` and down to here).
// `unmountBeforeRender` (below) closes the underlying duplicate-registration defect itself, for
// every handler a mounted tree happens to register, not just the one that currently has a visible
// symptom — so a future `useKeyboard`/`usePaste` addition that DOES reach outside its own
// component's state does not silently reacquire the same failure mode Ctrl-C already had.
export function unmountBeforeRender(rawRoot: Root): Root {
  return {
    render: (node) => {
      // A safe no-op on the very first call (nothing mounted yet to tear down) — `Root`'s own
      // `unmount` is exactly the synchronous, real React unmount (running every effect's cleanup)
      // that a plain `root.render()` never triggers for whatever it is about to replace.
      rawRoot.unmount();
      rawRoot.render(node);
    },
    unmount: () => rawRoot.unmount(),
  };
}

// Idempotent: three call sites share this instance today (see this file's own header comment),
// so this stays safe to call more than once (returns the same instance) rather than assuming a
// single caller. Only the FIRST call's `configDir` is ever read, since every later one returns the
// instance already built — safe because all three resolve it from the same `deps.authConfigDir ??
// getConfigDir()` (cli.ts's `ctx.configDir`, forwarded to `runWelcomeSplash`/`runGuidedSetup`, and
// recomputed identically in `runTui`), so no caller can disagree with whichever ran first.
export async function getTuiRenderer(
  configDir: string,
): Promise<{ renderer: CliRenderer; root: Root }> {
  if (instance !== undefined) return instance;
  const renderer = await createCliRenderer(MAIN_TUI_RENDERER_CONFIG);
  suppressAlternateScroll();
  // Before `createRoot`/`root.render` below, so the opted-in ground is on the first painted frame
  // rather than arriving a frame late.
  applyTuiBackground(renderer, configDir);
  const root = unmountBeforeRender(createRoot(renderer));
  instance = { renderer, root };
  // Ctrl-C is registered once here, directly on the renderer's own key input, rather than via
  // `<App>`'s own `useKeyboard` (every call site used to pass an identical `onCancel: () =>
  // deliverSignal("SIGINT")` prop for exactly this) — `root`'s own unmount-before-render above
  // already closes the underlying multi-registration bug for every handler, but Ctrl-C stays its
  // own direct registration too: it must keep working even while a fatal path is already
  // unwinding this renderer, a moment `<App>`'s own tree may no longer be mounted to react to it.
  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.name === "c") deliverSignal("SIGINT");
  });
  // `createCliRenderer` above installs its OWN `process.on("uncaughtException"/"unhandledRejection",
  // ...)` pair unconditionally (confirmed by reading `@opentui/core`'s compiled source) — no config
  // option skips it, unlike `renderOptions.ts`'s own `exitSignals: []` for the equivalent OS-signal
  // hazard. That handler only logs (optionally opening a hidden debug-console overlay) and never
  // exits, so a bug completely unrelated to this renderer (a background fetch, a stray timer) would
  // otherwise be silently swallowed for as long as this renderer is alive, instead of crashing the
  // process the way it would have with no handler installed at all. Registered AFTER
  // `createCliRenderer`'s own pair, not before: `uncaughtException`/`unhandledRejection` call every
  // registered listener, in registration order, so this one still runs and still gets the final say
  // on whether the process actually exits.
  process.on("uncaughtException", (err) => {
    destroyTuiRenderer();
    console.error(messageOf(err));
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    destroyTuiRenderer();
    console.error(messageOf(err));
    process.exit(1);
  });
  // Registered once, at creation, so a fatal signal that arrives at any point across the whole
  // splash -> setup -> main-TUI window still restores the terminal (raw mode, alt-screen, cursor
  // visibility) rather than leaving it corrupted. Alternate scroll rides the same path for the same
  // reason: it is the one piece of terminal state OpenTUI's own `destroy()` does not know about.
  onSignalCleanupLast(() => {
    instance?.renderer.destroy();
    restoreAlternateScroll();
  });
  return instance;
}

// No-op if `getTuiRenderer` was never called — a fatal bailout before `runWelcomeSplash` ever
// creates the renderer must still be safe to call this.
export function destroyTuiRenderer(): void {
  if (instance === undefined) return;
  instance.renderer.destroy();
  instance = undefined;
  restoreAlternateScroll();
}
