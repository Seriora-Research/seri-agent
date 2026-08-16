// One continuous alt-screen session spanning all three sequential Ink mounts (welcome splash,
// guided setup, the main TUI) rather than Ink's own per-render() `alternateScreen` option, which
// has a per-mount lifetime and would swap the buffer once per mount instead of once per launch.
// `entered` makes "exactly once" true by construction: every exit path (normal exit, `process.on
// ("exit")`, `onSignalCleanupLast`) calls `exitAltScreen`, and only the first of those actually
// writes anything.
import { onSignalCleanupLast } from "../signals";

let entered = false;

// No `isTTY` check of its own: CliDeps.isTTY's own comment (cli.ts) says that flag is read from
// `process.stdout.isTTY` in exactly one place, the entrypoint — this function's sole caller is
// already inside `run()`'s own `if (isTTY)` block, so a second, live `process.stdout.isTTY` read
// here would be a second source of truth that can disagree with the first (e.g. a test calling
// `run(argv, { isTTY: true })` against a piped stdout).
export function enterAltScreen(): void {
  if (entered) return;
  entered = true;
  process.stdout.write("\x1b[?1049h");
  process.on("exit", exitAltScreen);
  onSignalCleanupLast(exitAltScreen);
}

export function exitAltScreen(): void {
  if (!entered) return;
  entered = false;
  try {
    process.stdout.write("\x1b[?1049l");
    process.stdout.write("\x1b[?25h");
  } catch {}
}
