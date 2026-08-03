// The process's one SIGINT/SIGTERM owner. Everything else that has to clean up on Ctrl-C
// registers a callback here instead of adding a listener of its own, because the re-raise below
// kills the process where it stands: whatever has not already run does not run at all.
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
    // them is what makes the re-raise land rather than re-entering this handler. What clearing
    // them does not do is drop a listener registered later: emit iterates a clone of the array,
    // so that one still runs in this same emit (measured: ran = ["first","second"]). The kill
    // is what drops it — measured on Linux, a handler that re-raises never reaches its next
    // line, so a second listener never gets its turn. Hence the registry above.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}
