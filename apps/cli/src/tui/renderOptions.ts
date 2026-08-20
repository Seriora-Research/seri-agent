// The main TUI mount's own Ink `render()` options (`cli.ts`'s `runTui`) — pulled out so
// `inputRenderCost.test.tsx`'s regression test can import the SAME object instead of a
// hardcoded copy, which would keep passing even if `cli.ts` ever reverted `incrementalRendering`.
import type { RenderOptions } from "ink";

// `interactive: true` — without it, Ink's own auto-detection (`ink.js`'s `resolveInteractiveOption`,
// `interactive ?? (!isInCi && stdout.isTTY)`) weighs the `CI` env var over the real terminal:
// whenever `CI`/`CONTINUOUS_INTEGRATION` is set (GitHub Actions sets `CI=true` on every job,
// unconditionally, even for a job that allocated a real pty), Ink decides it is non-interactive
// and stops live-rendering — it batches everything and "writes only the final frame at unmount"
// per its own docs — REGARDLESS of `stdout.isTTY`. This is what made every pty test in
// tuiPty.test.ts fail on CI's ubuntu-latest/macos-latest runners (reproduced locally by setting
// `CI=true` in WSL2, confirmed fixed by this option, confirmed still green without it) while
// passing 100% on WSL2, where `CI` is unset: keystrokes reached the process (confirmed with a
// raw stdin listener bypassing Ink entirely) but nothing was ever rendered to observe. seri
// already does its own, more accurate interactivity check before ever reaching this line —
// `runTui` is only called when `deps.isTTY` was true (`run()`'s own `isTTY ? await runTui(...) :
// ...`) — so overriding Ink's redundant, CI-env-var-driven second guess with that already-made
// decision is correct here, not just a test workaround: a real user running seri interactively
// inside any environment that happens to set `CI=true` (some devcontainers and cloud IDEs do,
// even for a genuinely interactive session) would hit the identical silent degradation.
//
// `incrementalRendering: true` — without it, `log-update.js`'s default writer
// (`createStandard`) erases and re-emits the ENTIRE frame on every changed frame: every
// transcript row, unchanged or not, plus the mode line and borders. Holding Backspace repeats
// at up to ~30 keystrokes/second, each one re-emitting the whole screen regardless of how
// little of it changed. `createIncremental` skips a transcript row whose text is identical to
// the previous frame and emits a bare cursor move instead, so cost scales with what actually
// changed (the input box) rather than with how much is on screen. This only reaches
// `createIncremental`'s writer at all because `App.tsx` already renders its root `Box` at
// `height={rows - 1}`, one row short of the terminal — see that `Box`'s own comment: at a full
// `rows`, Ink's fullscreen/clearTerminal path bypasses `this.log` (and `incrementalRendering`
// with it) entirely, so this option depends on `App.tsx` staying one row short.
export const MAIN_TUI_RENDER_OPTIONS: RenderOptions = {
  exitOnCtrlC: false,
  interactive: true,
  incrementalRendering: true,
};
