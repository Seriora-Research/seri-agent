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
  try {
    process.stdout.write("\x1b[?1049l");
    process.stdout.write("\x1b[?25h");
    // Only after BOTH writes succeed (found by review): flipping this first meant that if the
    // buffer-restore write succeeded but the cursor-show write then threw (stdout closing between
    // the two, a killed/detached terminal), the error was swallowed by the bare `catch` below with
    // `entered` already false — no later call from any of the exit paths listed above could ever
    // retry, leaving the terminal on the primary buffer with the cursor permanently hidden for the
    // rest of the shell session. Left `true` on a thrown write, the next exit path's own call is a
    // real retry instead of the no-op `if (!entered) return` above would otherwise make it.
    //
    // `process.off` lives HERE, not ahead of the try (found by review, round 2 of this same fix):
    // deregistering the "exit" listener before the writes even run would defeat the retry this
    // comment just described — a listener removed unconditionally can't fire again to retry a write
    // that hasn't happened yet. Only removed once the writes are confirmed to have actually
    // succeeded, alongside `entered`, for the same reason `enterAltScreen` re-registers a fresh one
    // every time it transitions false → true: at most one live registration either way, just never
    // torn down before it might still be needed.
    entered = false;
    process.off("exit", exitAltScreen);
  } catch {}
}
