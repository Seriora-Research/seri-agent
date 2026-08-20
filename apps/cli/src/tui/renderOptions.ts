// The main TUI mount's own Ink `render()` options (`cli.ts`'s `runTui`).
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
export const MAIN_TUI_RENDER_OPTIONS: RenderOptions = {
  exitOnCtrlC: false,
  interactive: true,
};
