


















const cleanups: Array<() => void> = [];

export function onSignalCleanup(fn: () => void): void {
  cleanups.push(fn);
}





let cancel: ((signal: NodeJS.Signals) => void) | undefined;

export function onSignalCancel(fn: (signal: NodeJS.Signals) => void): () => void {
  cancel = fn;
  return () => {
    if (cancel === fn) cancel = undefined;
  };
}








let lastCleanup: (() => void) | undefined;

export function onSignalCleanupLast(fn: () => void): void {
  lastCleanup = fn;
}











export function raiseSignal(signal: NodeJS.Signals): void {
  process.removeAllListeners(signal);
  // bun on Linux: the line after process.kill(process.pid, signal) never runs.
  process.kill(process.pid, signal);
}








export function deliverSignal(signal: NodeJS.Signals): void {
















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

    }
  }

  try {
    lastCleanup?.();
  } catch {

  }

  raiseSignal(signal);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => deliverSignal(signal));
}
