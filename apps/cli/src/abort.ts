// An AbortSignal that is ALREADY aborted fires no `abort` event, so registering a listener is not
// enough on its own. The window is real rather than theoretical: loop.ts checks the signal before a
// tool call, then yields a tool-call event, and the consumer's signal handler runs in exactly that
// suspension — so by the time the tool registers its listener the cancel has been and gone, and the
// command would run to completion and return a normal-looking result for work the user stopped.
// Registering, and invoking the handler immediately when the signal is already past, are therefore
// one operation here rather than three lines each caller has to remember to write the same way.
//
// Beside signals.ts rather than under tools/ because the third caller is cli.ts's approval prompt,
// which is not a tool.
export type AbortRegistration = {
  // Whether the cancel ran, so a caller settling later can tell a cancelled outcome from an
  // ordinary one.
  aborted: () => boolean;
  // Drops the listener once the work has settled. A no-op when no signal was passed.
  dispose: () => void;
};

export function onAbort(signal: AbortSignal | undefined, cancel: () => void): AbortRegistration {
  let aborted = false;
  const handler = (): void => {
    aborted = true;
    cancel();
  };
  signal?.addEventListener("abort", handler);
  if (signal?.aborted === true) handler();

  return {
    aborted: () => aborted,
    dispose: () => signal?.removeEventListener("abort", handler),
  };
}
