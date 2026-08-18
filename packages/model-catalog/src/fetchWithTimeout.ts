// Shared by loadCatalog (this package) and apps/cli's fetchAccountPlan — both needed the
// identical "abort a fetch that never settles" shape and used to hand-duplicate it. A plain
// AbortController + setTimeout, not AbortSignal.timeout(): verified live that AbortSignal.timeout()'s
// own internal timer does not reliably fire when it is the only pending timer-driven thing in an
// otherwise-idle event loop (a real CLI session's other concurrent I/O will almost always mask
// this, but nothing here should depend on that coincidence) — a plain setTimeout fired reliably in
// the same isolated repro. `clearTimeout` in `finally` is what stops the timer from outliving a
// response that arrives before the deadline.
// `fetchFn`'s type is the bare call signature (a plain string URL, matching every real call site
// here), not `typeof fetch`: a caller that wraps the real fetch (apps/cli's authedFetch, say)
// returns a plain function lacking the static members bun-types augments the global `fetch` type
// with (`.preconnect`), and this accepts either without a cast at the call site.
// `init` is optional and merged under `signal` (never over it — a caller-supplied `init.signal`
// would defeat the one thing this function exists to guarantee) so a POST body/headers caller
// (auth/refresh.ts's own refreshAccessToken) can reuse this instead of hand-rolling the same
// controller/timer/clearTimeout dance a second time.
export async function fetchWithTimeout(
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
