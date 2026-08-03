// The process's one SIGINT/SIGTERM owner. Everything else that has to clean up on Ctrl-C
// registers a callback here instead of adding a listener of its own, because a second listener
// is work that never happens: the re-raise below kills the process where it stands. Measured in
// bun on Linux — the handler's first line runs, the line after process.kill(process.pid, signal)
// never does. Note that removeAllListeners is not what drops the second listener; emit iterates
// a clone of the array, so a listener registered later still runs in that same emit (measured:
// ran = ["first","second"]). The kill is what drops it, which is why this registry exists.
//
// A cleanup must not throw — it would take the remaining cleanups and the re-raise with it — and
// must not depend on running before or after another, since this array is ordered by nothing
// more meaningful than module import order.
const cleanups: Array<() => void> = [];

export function onSignalCleanup(fn: () => void): void {
  cleanups.push(fn);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const fn of cleanups) fn();

    // Re-raise instead of exiting with 128 + n. A normal exit reports a status, not a death by
    // signal, and shells branch on that: `for f in a b c; do hesper "$f"; done` only breaks out
    // of the loop when the child was killed *by* SIGINT, so a plain exit would turn one Ctrl-C
    // into one press per iteration. xargs and make read it the same way.
    //
    // Node only restores a signal's default disposition when no listener is left, so clearing
    // them is what makes the re-raise land rather than re-entering this handler.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}
