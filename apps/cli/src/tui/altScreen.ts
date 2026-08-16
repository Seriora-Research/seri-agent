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
  // Found by review: `enterAltScreen` registers a fresh `process.on("exit", ...)` listener every
  // time it transitions `entered` false → true, and nothing removed the PREVIOUS one — dormant in
  // production (one `run()` call per process, so at most one registration ever happens), but a live
  // leak for anything that calls `run()` repeatedly in one process (a test, an embedder), eventually
  // tripping Node's MaxListenersExceededWarning. `process.off`, not a one-shot `{ once: true }` on
  // the `.on` call: the "exit" event only ever fires once per process regardless, so the listener
  // was already effectively single-use — this just makes the bookkeeping accurate rather than
  // leaving a reference to `exitAltScreen` (and everything its closure keeps alive) registered on
  // `process` forever after the alt screen has already been torn down.
  process.off("exit", exitAltScreen);
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
    entered = false;
  } catch {}
}
