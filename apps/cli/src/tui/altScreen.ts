// One continuous alt-screen session spanning all three sequential Ink mounts (welcome splash,
// guided setup, the main TUI) rather than Ink's own per-render() `alternateScreen` option, which
// has a per-mount lifetime and would swap the buffer once per mount instead of once per launch.
// `entered` makes "exactly once" true by construction: every exit path (normal exit, `process.on
// ("exit")`, `onSignalCleanupLast`) calls `exitAltScreen`, and only the first of those actually
// writes anything.
import { onSignalCleanupLast } from "../signals";

let entered = false;

export function enterAltScreen(): void {
  if (entered || !process.stdout.isTTY) return;
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
