









export type AbortRegistration = {


  aborted: () => boolean;

  dispose: () => void;
};

export function abortedError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

export function onAbort(signal: AbortSignal | undefined, cancel: () => void): AbortRegistration {
  let aborted = false;
  const handler = (): void => {
    aborted = true;
    cancel();
  };
  signal?.addEventListener("abort", handler);
  // An already-aborted AbortSignal fires no `abort` event.
  if (signal?.aborted === true) handler();

  return {
    aborted: () => aborted,
    dispose: () => signal?.removeEventListener("abort", handler),
  };
}
