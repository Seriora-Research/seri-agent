import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { type LanguageModel, type ProviderMetadata, wrapLanguageModel } from "ai";

/** Sentence recovered from a Responses refusal part. `text` may be empty when the part was present and carried no words. */
export type ModelRefusal = { readonly text: string };

type RefusalState = {
  deltas: string;
  sawDelta: boolean;
  done: string | undefined;
  itemParts: string[];
  sawItem: boolean;
  completedParts: string[];
  sawCompleted: boolean;
};

function emptyRefusal(): RefusalState {
  return {
    deltas: "",
    sawDelta: false,
    done: undefined,
    itemParts: [],
    sawItem: false,
    completedParts: [],
    sawCompleted: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refusalField(part: unknown): string | undefined {
  if (!isRecord(part) || part.type !== "refusal" || typeof part.refusal !== "string") {
    return undefined;
  }
  return part.refusal;
}

function refusalStrings(content: unknown): { texts: string[]; saw: boolean } {
  if (!Array.isArray(content)) return { texts: [], saw: false };
  const texts: string[] = [];
  let saw = false;
  for (const part of content) {
    const refusal = refusalField(part);
    if (refusal === undefined) continue;
    saw = true;
    const text = refusal.trim();
    if (text.length > 0) texts.push(text);
  }
  return { texts, saw };
}

// A later event that repeats the sentence does not get appended. An empty part still counts.
function finishRefusal(state: RefusalState): string | undefined {
  if (state.itemParts.length > 0) return state.itemParts.join("\n");
  const done = state.done?.trim() ?? "";
  if (done.length > 0) return done;
  if (state.completedParts.length > 0) return state.completedParts.join("\n");
  const deltas = state.deltas.trim();
  if (deltas.length > 0) return deltas;
  if (state.sawItem || state.done !== undefined || state.sawCompleted || state.sawDelta) return "";
  return undefined;
}

function reduceRefusalEvent(state: RefusalState, event: unknown): RefusalState {
  if (!isRecord(event) || typeof event.type !== "string") return state;
  switch (event.type) {
    case "response.refusal.delta": {
      if (typeof event.delta !== "string") return state;
      return { ...state, sawDelta: true, deltas: state.deltas + event.delta };
    }
    case "response.refusal.done": {
      if (typeof event.refusal !== "string") return state;
      return { ...state, done: event.refusal };
    }
    case "response.content_part.added": {
      const refusal = refusalField(event.part);
      // The stream opens the part with an empty string. That is not the sentence.
      if (refusal === undefined || refusal.trim().length === 0) return state;
      if (state.done !== undefined) return state;
      return { ...state, done: refusal };
    }
    case "response.content_part.done": {
      const refusal = refusalField(event.part);
      if (refusal === undefined || state.done !== undefined) return state;
      return { ...state, done: refusal };
    }
    case "response.output_item.done": {
      if (!isRecord(event.item) || event.item.type !== "message") return state;
      const found = refusalStrings(event.item.content);
      if (!found.saw) return state;
      return { ...state, sawItem: true, itemParts: [...state.itemParts, ...found.texts] };
    }
    case "response.completed":
    case "response.incomplete": {
      if (!isRecord(event.response) || !Array.isArray(event.response.output)) return state;
      const texts: string[] = [];
      let saw = false;
      for (const item of event.response.output) {
        if (!isRecord(item) || item.type !== "message") continue;
        const found = refusalStrings(item.content);
        if (!found.saw) continue;
        saw = true;
        texts.push(...found.texts);
      }
      if (!saw) return state;
      return { ...state, sawCompleted: true, completedParts: texts };
    }
    default:
      return state;
  }
}

function takeLines(buffer: string, onLine: (line: string) => void): string {
  let start = 0;
  while (true) {
    const nl = buffer.indexOf("\n", start);
    if (nl === -1) return buffer.slice(start);
    let line = buffer.slice(start, nl);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    onLine(line);
    start = nl + 1;
  }
}

async function scanRefusal(body: ReadableStream<Uint8Array>): Promise<string | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let state = emptyRefusal();
  const flushEvent = () => {
    if (data.length === 0) return;
    const payload = data.join("\n").trim();
    data = [];
    if (payload.length === 0 || payload === "[DONE]") return;
    try {
      state = reduceRefusalEvent(state, JSON.parse(payload) as unknown);
    } catch {
      // Malformed JSON is one event, not a failed turn.
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = takeLines(buffer, (line) => {
        if (line.length === 0) flushEvent();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      });
    }
    buffer += decoder.decode();
    if (buffer.length > 0 && buffer.startsWith("data:")) {
      data.push(buffer.slice(5).trimStart());
    }
    flushEvent();
  } finally {
    reader.releaseLock();
  }
  return finishRefusal(state);
}

function readResponsesRefusal(body: ReadableStream<Uint8Array>): Promise<string | undefined> {
  // A scanner failure must not turn a normal answer into a refusal.
  return scanRefusal(body).catch(() => undefined);
}

function capturingFetch(
  inner: typeof fetch,
  publish: (refusal: Promise<string | undefined>) => void,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await inner(input, init);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (
      response.status !== 200 ||
      response.body === null ||
      !contentType.includes("text/event-stream")
    ) {
      // A later non-stream response must not clear a refusal already recorded for this call.
      return response;
    }
    const [forSdk, forScan] = response.body.tee();
    publish(readResponsesRefusal(forScan));
    return new Response(forSdk, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;
}

function mergeRefusal(
  part: Extract<LanguageModelV4StreamPart, { type: "finish" }>,
  text: string,
): LanguageModelV4StreamPart {
  return {
    ...part,
    providerMetadata: {
      ...part.providerMetadata,
      seri: { ...part.providerMetadata?.seri, modelRefusal: text },
    },
  };
}

function stampFinish(
  stream: ReadableStream<LanguageModelV4StreamPart>,
  refusal: () => Promise<string | undefined>,
): ReadableStream<LanguageModelV4StreamPart> {
  return stream.pipeThrough(
    new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
      async transform(part, controller) {
        if (part.type !== "finish") {
          controller.enqueue(part);
          return;
        }
        const text = await refusal();
        if (typeof text !== "string") {
          controller.enqueue(part);
          return;
        }
        controller.enqueue(mergeRefusal(part, text));
      },
    }),
  );
}

export function withRefusalRecovery(
  innerFetch: typeof fetch | undefined,
  build: (fetchImpl: typeof fetch) => LanguageModelV4,
): LanguageModel {
  const baseFetch = innerFetch ?? globalThis.fetch;
  return wrapLanguageModel({
    model: build(baseFetch),
    middleware: {
      wrapStream: async ({ params }) => {
        let refusal: Promise<string | undefined> = Promise.resolve(undefined);
        const result = await build(
          capturingFetch(baseFetch, (pending) => {
            refusal = pending;
          }),
        ).doStream(params);
        return {
          ...result,
          stream: stampFinish(result.stream, () => refusal),
        } satisfies LanguageModelV4StreamResult;
      },
    },
  });
}

export function modelRefusalFromProviderMetadata(
  metadata: ProviderMetadata | undefined,
): ModelRefusal | undefined {
  const text = metadata?.seri?.modelRefusal;
  return typeof text === "string" ? { text } : undefined;
}
