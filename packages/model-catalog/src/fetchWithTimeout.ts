// Shared by loadCatalog (this package), apps/cli's fetchAccountPlan, and refreshAccessToken —
// all three needed the identical "abort a fetch that never settles" shape and used to
// hand-duplicate it. A plain AbortController + setTimeout, not AbortSignal.timeout(): verified
// live that AbortSignal.timeout()'s own internal timer does not reliably fire when it is the only
// pending timer-driven thing in an otherwise-idle event loop (a real CLI session's other
// concurrent I/O will almost always mask this, but nothing here should depend on that
// coincidence) — a plain setTimeout fired reliably in the same isolated repro. `clearTimeout` in
// `finally` is what stops the timer from outliving a call that finishes before the deadline.
// `fetchFn`'s type is the bare call signature (a plain string URL, matching every real call site
// here), not `typeof fetch`: a caller that wraps the real fetch (apps/cli's authedFetch, say)
// returns a plain function lacking the static members bun-types augments the global `fetch` type
// with (`.preconnect`), and this accepts either without a cast at the call site.
// `init` is optional and merged under `signal` (never over it — a caller-supplied `init.signal`
// would defeat the one thing this function exists to guarantee) so a POST body/headers caller
// can reuse this instead of hand-rolling the same controller/timer/clearTimeout dance again.
//
// `read` runs INSIDE the same try, not after this function returns — bug fixed here (code-review
// finding): `fetchFn` resolving only means the response HEADERS arrived, not that the whole
// response did. An earlier version returned the bare `Response` and cleared the timer right then,
// so a caller's own later `response.json()`/`.text()` read the body with no timeout guarding it
// at all — every caller's own ORIGINAL code (before this helper existed) read the body inside the
// same try/finally the timer lived in, so a stalled body-read still tripped the deadline; this
// restores that guarantee in the shared version instead of silently dropping it.
export async function fetchWithTimeout<T>(
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
  timeoutMs: number,
  read: (response: Response) => Promise<T>,
  init?: RequestInit,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    return await read(response);
  } finally {
    clearTimeout(timer);
  }
}
