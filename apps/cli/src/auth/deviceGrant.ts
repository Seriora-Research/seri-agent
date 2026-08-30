// The RFC 8628 polling loop, shared by every device-code flow seri runs (WorkOS's own /login in
// deviceFlow.ts, xAI's subscription connect in xaiOAuth.ts). Extracted rather than copied: the
// abort handling below is a thermo-nuclear round-5 bug fix, and a second hand-written copy of a
// subtle race is how that fix comes back as a bug in the duplicate.
//
// The loop owns timing, RFC 8628 error semantics, and cancellation. It deliberately does NOT own
// the token request's shape or the success payload — each caller supplies its own body and maps
// the response itself, because those genuinely differ per issuer.

export type DeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

// The terminal states every device grant shares. A caller's own success type rides in `value`.
// "tier-denied" is xAI-specific in practice but lives here because it is a terminal outcome the
// loop itself has to stop on — folding it into "error" would let a caller retry a state that no
// retry can fix.
export type DeviceGrantResult<T> =
  | { status: "success"; value: T }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "tier-denied"; message: string }
  | { status: "error"; message: string }
  | { status: "aborted" };

export type PollOptions<T> = {
  tokenUrl: string;
  // Rebuilt per attempt rather than passed as a fixed value: a URLSearchParams is stateful and
  // reusing one across retries risks a caller mutating it between attempts.
  body: () => URLSearchParams;
  onSuccess: (payload: Record<string, unknown>) => T;
  // Each issuer words its own terminal-error copy, and those strings are user-facing, so the
  // wording stays with the caller rather than being genericised here.
  describeError?: (raw: unknown) => string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
};

export async function parseResponseBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 200) };
  }
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A function, not an inlined `signal?.aborted === true` at each call site: TS's control-flow
// narrowing treats a property read as stable across an `await` within the same scope (it isn't,
// for a mutable external AbortSignal), and narrows the second read to `false | undefined`, a real
// type error. A function call is an opaque boundary narrowing can't see through.
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function pollDeviceGrant<T>(
  device: DeviceAuthorization,
  opts: PollOptions<T>,
): Promise<DeviceGrantResult<T>> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const signal = opts.signal;

  let interval = device.interval;
  const deadline = now() + device.expiresIn * 1000;

  while (true) {
    if (now() >= deadline) return { status: "expired" };
    if (isAborted(signal)) return { status: "aborted" };

    await sleep(interval * 1000);

    const response = await fetchFn(opts.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: opts.body().toString(),
    });
    const payload = await parseResponseBody(response);
    // Re-checked here, not just at the top of the loop: an abort that lands WHILE this iteration's
    // own sleep+fetch is already in flight must still discard whatever this poll just resolved to
    // — including a genuine success — rather than acting on it one iteration late.
    if (isAborted(signal)) return { status: "aborted" };

    if (response.ok) return { status: "success", value: opts.onSuccess(payload) };

    // Terminal before the RFC's own error vocabulary, because it is decided by HTTP status rather
    // than by an `error` field: the account authenticated fine, its plan just is not allowed.
    // Never retried — no amount of polling or re-consent changes a subscription tier.
    if (response.status === 403) {
      return {
        status: "tier-denied",
        message: String(payload.error_description ?? payload.error ?? "Plan tier not allowed"),
      };
    }

    if (payload.error === "authorization_pending") continue;
    // RFC 8628: on slow_down, increase the polling interval by (at least) 5 seconds.
    if (payload.error === "slow_down") {
      interval += 5;
      continue;
    }
    if (payload.error === "expired_token") return { status: "expired" };
    if (payload.error === "access_denied") return { status: "denied" };
    const raw = payload.error ?? response.status;
    return {
      status: "error",
      message: opts.describeError?.(raw) ?? `Device authorization failed: ${raw}`,
    };
  }
}
