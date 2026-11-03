import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { type LanguageModel, wrapLanguageModel } from "ai";
import { type AbortRegistration, abortedError, onAbort } from "../abort";

/**
 * How long one provider request may wait on the provider.
 *
 * `firstByteMs` runs from the request to its first output part, headers included, and bounds a
 * whole non-streaming call. Expiry retries once on a new request, then fails.
 *
 * `idleMs` runs between output parts once output has reached the caller. Expiry fails the
 * request. Time the caller spends not reading is not counted.
 */
export type StallDeadlines = {
  readonly firstByteMs: number;
  readonly idleMs: number;
};

const DEFAULT_STALL_DEADLINES: StallDeadlines = {
  // Routes that hide reasoning send no part until the reasoning is done.
  firstByteMs: 300_000,
  // Responses-API reasoning can sit silent between `reasoning-start` and the answer.
  idleMs: 300_000,
};

/**
 * A deadline aborts only the request it guards, never the caller's signal, so a stall stays an
 * error and a caller abort stays an abort. Provider errors pass through unchanged, so the SDK
 * still retries 429/5xx.
 */
export function withStallDeadlines(
  model: LanguageModel,
  deadlines: StallDeadlines = DEFAULT_STALL_DEADLINES,
): LanguageModel {
  if (typeof model === "string") {
    throw new TypeError("withStallDeadlines needs a model object, not a model id");
  }
  const checked = parseStallDeadlines(deadlines);
  // The `doStream`/`doGenerate` callbacks always send the caller's signal. Calling the layer
  // beneath directly lets each attempt carry its own.
  return wrapLanguageModel({
    model,
    middleware: {
      wrapStream: ({ model: inner, params }) =>
        retryOnce(params.abortSignal, checked, (request) =>
          awaitFirstOutput(inner, params, request, checked),
        ),
      wrapGenerate: ({ model: inner, params }) =>
        retryOnce(params.abortSignal, checked, (request) =>
          raceNext(
            () => inner.doGenerate({ ...params, abortSignal: request.signal }),
            checked.firstByteMs,
            params.abortSignal,
          ),
        ),
    },
  });
}

function parseStallDeadlines(deadlines: StallDeadlines): StallDeadlines {
  for (const field of ["firstByteMs", "idleMs"] as const) {
    const ms = deadlines[field];
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new RangeError(`${field} must be a finite number of milliseconds above 0, got ${ms}`);
    }
  }
  return deadlines;
}

/**
 * silent: the connection is open, nothing more. Held before the first output and never resets a
 * deadline. live: the model produced something. final: the reply is complete, so a later stall
 * closes the stream instead of failing it.
 */
type Pulse = "silent" | "live" | "final";

// One row per provider part type, so a part type added by `ai` fails the build here.
const PART_PULSE = {
  "stream-start": "silent",
  "response-metadata": "silent",
  raw: "silent",
  "text-start": "silent",
  "text-delta": "live",
  "text-end": "silent",
  // A model that has started thinking is working; a retry would throw that work away.
  "reasoning-start": "live",
  "reasoning-delta": "live",
  "reasoning-end": "silent",
  "tool-input-start": "silent",
  "tool-input-delta": "live",
  "tool-input-end": "silent",
  "tool-approval-request": "live",
  "tool-call": "live",
  "tool-result": "live",
  custom: "live",
  file: "live",
  "reasoning-file": "live",
  source: "live",
  // runLoop's overflow and credit retries read a provider error; holding it would delay them.
  error: "live",
  finish: "final",
} as const satisfies Record<LanguageModelV4StreamPart["type"], Pulse>;

function pulseOf(part: LanguageModelV4StreamPart): Pulse {
  return "delta" in part && part.delta.length === 0 ? "silent" : PART_PULSE[part.type];
}

type Attempt = 1 | 2;

/** A first-byte stall carries attempt 2, because attempt 1 retries instead of failing. */
type Stall = { readonly phase: "first-byte"; readonly attempt: 2 } | { readonly phase: "idle" };

class ModelStallError extends Error {
  constructor(stall: Stall, deadlines: StallDeadlines) {
    super(
      stall.phase === "first-byte"
        ? `the model sent no output within ${duration(deadlines.firstByteMs)} on two attempts, so seri stopped waiting.`
        : `the model stream went silent for ${duration(deadlines.idleMs)} after it started, so seri stopped this request.`,
    );
    this.name = "ModelStallError";
  }
}

function duration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

/** One provider request. Aborting it tears down that request's fetch and nothing else. */
type ProviderRequest = {
  readonly signal: AbortSignal;
  readonly expire: () => void;
};

function openRequest(caller: AbortSignal | undefined): ProviderRequest {
  const own = new AbortController();
  return {
    signal: caller === undefined ? own.signal : AbortSignal.any([caller, own.signal]),
    expire: () => own.abort(),
  };
}

type Raced<T> = { readonly kind: "value"; readonly value: T } | { readonly kind: "expired" };

const EXPIRED = { kind: "expired" } as const;

/**
 * Starts `next` and waits at most `remainingMs` for it. Its rejection passes through unchanged. A
 * caller abort rejects with the caller's reason, and wins over a deadline that lands with it.
 */
async function raceNext<T>(
  next: () => PromiseLike<T>,
  remainingMs: number,
  caller: AbortSignal | undefined,
): Promise<Raced<T>> {
  if (caller?.aborted) throw abortedError(caller);
  const pending = Promise.resolve(next());
  const settled = pending.then((value) => ({ kind: "value", value }) as const);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: AbortRegistration | undefined;
  const deadline = new Promise<typeof EXPIRED>((resolve) => {
    timer = setTimeout(() => resolve(EXPIRED), remainingMs);
    timer.unref();
  });
  const aborted = new Promise<never>((_, reject) => {
    if (caller !== undefined) abort = onAbort(caller, () => reject(abortedError(caller)));
  });
  try {
    const first = await Promise.race([settled, deadline, aborted]);
    if (first.kind === "value") return first;
    // A value that settles in the same turn as the deadline still counts.
    const late = await Promise.race([settled, EXPIRED]);
    if (late.kind === "value") return late;
    if (caller?.aborted) throw abortedError(caller);
    pending.catch(() => {});
    return EXPIRED;
  } finally {
    clearTimeout(timer);
    abort?.dispose();
  }
}

async function retryOnce<T>(
  caller: AbortSignal | undefined,
  deadlines: StallDeadlines,
  send: (request: ProviderRequest) => Promise<Raced<T>>,
): Promise<T> {
  for (let attempt: Attempt = 1; ; attempt = 2) {
    const request = openRequest(caller);
    const outcome = await send(request);
    if (outcome.kind === "value") return outcome.value;
    request.expire();
    if (attempt === 2) throw new ModelStallError({ phase: "first-byte", attempt }, deadlines);
  }
}

/**
 * Reads until the first part that is not silent, or until the body closes, holding every part
 * read so far. Holding them is what keeps a retry out of the caller's stream.
 */
async function awaitFirstOutput(
  inner: LanguageModelV4,
  params: LanguageModelV4CallOptions,
  request: ProviderRequest,
  deadlines: StallDeadlines,
): Promise<Raced<LanguageModelV4StreamResult>> {
  const caller = params.abortSignal;
  const deadline = performance.now() + deadlines.firstByteMs;
  const remainingMs = () => Math.max(0, deadline - performance.now());
  const opened = await raceNext(
    () => inner.doStream({ ...params, abortSignal: request.signal }),
    remainingMs(),
    caller,
  );
  if (opened.kind === "expired") return opened;
  const reader = opened.value.stream.getReader();
  const held: LanguageModelV4StreamPart[] = [];
  let pulse: Pulse = "silent";
  while (pulse === "silent") {
    const next = await raceNext(() => reader.read(), remainingMs(), caller);
    if (next.kind === "expired") {
      reader.cancel().catch(() => {});
      return next;
    }
    if (next.value.done) break;
    held.push(next.value.value);
    pulse = pulseOf(next.value.value);
  }
  return {
    kind: "value",
    value: { ...opened.value, stream: watchedStream(held, reader, request, caller, deadlines) },
  };
}

function watchedStream(
  held: readonly LanguageModelV4StreamPart[],
  reader: ReadableStreamDefaultReader<LanguageModelV4StreamPart>,
  request: ProviderRequest,
  caller: AbortSignal | undefined,
  deadlines: StallDeadlines,
): ReadableStream<LanguageModelV4StreamPart> {
  let finished = held.some((part) => part.type === "finish");
  let remainingMs = deadlines.idleMs;
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const part of held) controller.enqueue(part);
    },
    async pull(controller) {
      const started = performance.now();
      const next = await raceNext(() => reader.read(), remainingMs, caller);
      if (next.kind === "expired") {
        request.expire();
        reader.cancel().catch(() => {});
        if (!finished) {
          const error = new ModelStallError({ phase: "idle" }, deadlines);
          controller.enqueue({ type: "error", error });
        }
        controller.close();
        return;
      }
      if (next.value.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value.value);
      const pulse = pulseOf(next.value.value);
      if (pulse === "final") finished = true;
      remainingMs =
        pulse === "silent"
          ? Math.max(0, remainingMs - (performance.now() - started))
          : deadlines.idleMs;
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
