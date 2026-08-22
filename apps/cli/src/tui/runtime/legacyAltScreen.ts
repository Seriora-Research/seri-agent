// PROVISIONAL — not the real Decision 1 consolidation (docs/specs/025-tui-opentui-migration/
// spec.md), a narrower stopgap for this dispatch's own boundary: `welcomeSplash.ts` and
// `guidedSetup.ts` still mount their own separate `ink` `render()` calls (a later migration
// dispatch's job to port) and never owned their own alt-screen entry -- they always relied on
// `cli.ts` wrapping the whole welcome-splash -> guided-setup -> main-TUI sequence in one
// continuous alt-screen session from outside. `runTui`'s own mount now owns ITS OWN alt-screen
// entry/exit via `runtime/renderer.ts`'s `screenMode: "alternate-screen"` config, so this module's
// job shrinks to just the two ink mounts that precede it: entered once before
// `runWelcomeSplash`, exited once after `runTui` resolves (or on a fatal bailout before it ever
// mounts) — exactly `altScreen.ts`'s old job, minus the third (`runTui`) mount it used to also
// cover. Real terminals treat a repeated `\x1b[?1049h`/`\x1b[?1049l` as a no-op, so this and
// `runtime/renderer.ts`'s own alt-screen entry briefly overlapping during `runTui`'s mount is
// harmless. Delete this file once a later dispatch ports `welcomeSplash.ts`/`guidedSetup.ts` onto
// the same shared renderer and Decision 1's single continuous instance is real.
import { onSignalCleanupLast } from "../../signals";

let entered = false;

// No `isTTY` check of its own: CliDeps.isTTY's own comment (cli.ts) says that flag is read from
// `process.stdout.isTTY` in exactly one place, the entrypoint — this function's sole caller is
// already inside `run()`'s own `if (isTTY)` block, so a second, live `process.stdout.isTTY` read
// here would be a second source of truth that can disagree with the first (e.g. a test calling
// `run(argv, { isTTY: true })` against a piped stdout).
export function enterAltScreen(): void {
  if (entered) return;
  entered = true;
  // Registered BEFORE the write, not after: exitAltScreen's own comment already treats a thrown
  // write as real (a killed/detached terminal). If the buffer-switch write below throws, the
  // caller's own catch (cli.ts) still reaches fatalDuringTui's single exitAltScreen() retry either
  // way, but registering these first means an uncaught throw elsewhere in the same synchronous
  // stack, before that catch runs, still has a listener in place rather than none at all.
  process.on("exit", exitAltScreen);
  onSignalCleanupLast(exitAltScreen);
  process.stdout.write("\x1b[?1049h");
}

export function exitAltScreen(): void {
  if (!entered) return;
  try {
    process.stdout.write("\x1b[?1049l");
    process.stdout.write("\x1b[?25h");
    // Only after BOTH writes succeed: flipping this first meant that if the
    // buffer-restore write succeeded but the cursor-show write then threw (stdout closing between
    // the two, a killed/detached terminal), the error was swallowed by the bare `catch` below with
    // `entered` already false — no later call from any of the exit paths listed above could ever
    // retry, leaving the terminal on the primary buffer with the cursor permanently hidden for the
    // rest of the shell session. Left `true` on a thrown write, the next exit path's own call is a
    // real retry instead of the no-op `if (!entered) return` above would otherwise make it.
    //
    // `process.off` lives HERE, not ahead of the try: deregistering the "exit" listener before the
    // writes even run would defeat the retry the comment above describes — a listener removed
    // unconditionally can't fire again to retry a write that hasn't happened yet. Only removed
    // once the writes are confirmed to have actually
    // succeeded, alongside `entered`, for the same reason `enterAltScreen` re-registers a fresh one
    // every time it transitions false → true: at most one live registration either way, just never
    // torn down before it might still be needed.
    entered = false;
    process.off("exit", exitAltScreen);
  } catch {}
}
