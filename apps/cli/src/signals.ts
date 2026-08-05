// The process's one SIGINT/SIGTERM owner. Everything else that has to clean up on Ctrl-C
// registers a callback here instead of adding a listener of its own, because a second listener
// is work that never happens: the re-raise below kills the process where it stands. Measured in
// bun on Linux — the handler's first line runs, the line after process.kill(process.pid, signal)
// never does. Note that removeAllListeners is not what drops the second listener; emit iterates
// a clone of the array, so a listener registered later still runs in that same emit (measured:
// ran = ["first","second"]). The kill is what drops it, which is why this registry exists. The
// cancel branch further down does return without killing, but it runs no cleanups at all — the
// fatal press is the one this list is for.
//
// A cleanup that throws is contained rather than trusted not to, which is a deliberate exception
// to this repo's "no error handling for scenarios that cannot happen" rule: the one registrant
// (killInFlightChildren, in spawnCollect.ts) cannot throw today, but one that did would skip every
// later cleanup AND the re-raise, so removeAllListeners would never run and the signal death would
// surface as an uncaught exception with exit 1 — inverting the very 128 + n semantics this file
// exists to protect. A cleanup must still not depend on running before or after another, and that
// half is not enforced: the array is ordered by nothing more meaningful than module import order.
const cleanups: Array<() => void> = [];

export function onSignalCleanup(fn: () => void): void {
  cleanups.push(fn);
}

// One slot, not a list, and not because a list would be harder: there is exactly one consumer
// (cli.ts) and exactly one thing a signal cancels (the in-flight turn), so a registry would
// advertise a generality that does not exist. Revisit when Stage 6's subagents need hierarchical
// cancellation, which is a different shape rather than more of this one.
let cancel: ((signal: NodeJS.Signals) => void) | undefined;

export function onSignalCancel(fn: (signal: NodeJS.Signals) => void): () => void {
  cancel = fn;
  return () => {
    if (cancel === fn) cancel = undefined;
  };
}

// Re-raise instead of exiting with 128 + n. A normal exit reports a status, not a death by
// signal, and shells branch on that: `for f in a b c; do seri "$f"; done` only breaks out
// of the loop when the child was killed *by* SIGINT, so a plain exit would turn one Ctrl-C
// into one press per iteration. xargs and make read it the same way.
//
// Node only restores a signal's default disposition when no listener is left, so clearing
// them is what makes the re-raise land rather than re-entering the handler.
//
// Exported because cli.ts ends a cancelled run the same way: the turn is abandoned, but the
// process still has to die the way Ctrl-C makes a process die.
export function raiseSignal(signal: NodeJS.Signals): void {
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
}

// What a press does, independent of how it arrived. Exported because one press does NOT arrive as
// a process signal: while cli.ts's approval prompt is up, readline has stdin in raw mode, so the
// tty stops generating SIGINT and hands 0x03 over as data, and readline emits the event on its own
// interface instead. Measured on a real pty with all three candidate handlers registered — rl's
// SIGINT and close fired, process.on("SIGINT") never did. That press has to spend the same single
// slot and fall through to the same fatal body as any other, so the prompt calls this rather than
// carrying a second copy of the rules that would drift from these.
export function deliverSignal(signal: NodeJS.Signals): void {
  // The first press, and it returns before the fatal body below rather than after it. That
  // ordering is the whole mechanism: removeAllListeners never runs, so the process listener is
  // still installed when the second press arrives, and clearing the slot as it is invoked is
  // what makes that second press fall through to the fatal path — no separate flag.
  //
  // The first press is not survival, it is an orderly death: cli.ts cancels the turn, lets it
  // unwind far enough to leave a resumable session, and then calls raiseSignal itself.
  //
  // SIGINT only, decided rather than inherited. Both signals reach this function, and letting a
  // SIGTERM take the cancel branch would silently change what `timeout 30 seri …`, a systemd stop
  // and a CI job canceller all get: they send SIGTERM once, expecting termination, and there is no
  // second press coming to convert into the fatal path. The unwind is bounded but not free — it
  // waits on whatever the in-flight tool does with its abort — so they would get a slower death and
  // nothing they can observe in exchange, since the resumable session an unwind leaves behind is a
  // Ctrl-C affordance for a human who intends to come back with --resume. So SIGTERM keeps the
  // behaviour it had before cancellation existed: cleanups, then die by signal.
  if (signal === "SIGINT" && cancel !== undefined) {
    const fn = cancel;
    cancel = undefined;
    fn(signal);
    return;
  }

  for (const fn of cleanups) {
    try {
      fn();
    } catch {
      // One cleanup's bug must not cost the others their turn, or the process its re-raise.
    }
  }

  raiseSignal(signal);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => deliverSignal(signal));
}
