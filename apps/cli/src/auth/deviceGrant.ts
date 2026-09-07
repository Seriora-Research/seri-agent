








export type DeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};





export type DeviceGrantResult<T> =
  | { status: "success"; value: T }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "tier-denied"; message: string }
  | { status: "error"; message: string }
  | { status: "aborted" };

export type PollOptions<T> = {
  tokenUrl: string;


  body: () => URLSearchParams;
  onSuccess: (payload: Record<string, unknown>) => T;


  describeError?: (raw: unknown) => string;




  tierDeniedOn403?: boolean;
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



    if (isAborted(signal)) return { status: "aborted" };

    if (response.ok) return { status: "success", value: opts.onSuccess(payload) };




    if (opts.tierDeniedOn403 === true && response.status === 403) {
      return {
        status: "tier-denied",
        message: String(payload.error_description ?? payload.error ?? "Plan tier not allowed"),
      };
    }

    if (payload.error === "authorization_pending") continue;

    // RFC 8628: on slow_down, increase the polling interval by at least 5 seconds.
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
