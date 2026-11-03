import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { type ModelMessage, simulateReadableStream, type ToolSet, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { abortedError, onAbort } from "../../src/abort";
import type { LoopEvent } from "../../src/loop/loop";

export function usage(inputTotal: number, outputTotal: number) {
  return {
    inputTokens: {
      total: inputTotal,
      noCache: inputTotal,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: outputTotal, text: outputTotal, reasoning: undefined },
  };
}

export function textOnlyChunks(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "text-start", id: "1" },
    { type: "text-delta", id: "1", delta: text },
    { type: "text-end", id: "1" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage(5, 5) },
  ];
}

export function reasoningThenTextChunks(
  thought: string,
  text: string,
): LanguageModelV4StreamPart[] {
  return [
    { type: "reasoning-start", id: "r1" },
    { type: "reasoning-delta", id: "r1", delta: thought },
    { type: "reasoning-end", id: "r1" },
    { type: "text-start", id: "1" },
    { type: "text-delta", id: "1", delta: text },
    { type: "text-end", id: "1" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage(5, 5) },
  ];
}

export function reasoningOnlyChunks(thought: string): LanguageModelV4StreamPart[] {
  return [
    { type: "reasoning-start", id: "r1" },
    { type: "reasoning-delta", id: "r1", delta: thought },
    { type: "reasoning-end", id: "r1" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage(5, 5) },
  ];
}

export function toolCallChunks(
  toolCallId: string,
  toolName: string,
  input: unknown,
  tokenUsage = usage(5, 5),
): LanguageModelV4StreamPart[] {
  return [
    { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: tokenUsage },
  ];
}

export const TRUNCATED_TOOL_INPUT = '{"path": "UNTERM_TOOL_ARG.txt", "content": "print(1';

export function truncatedToolCallChunks(
  toolCallId: string,
  toolName: string,
  input = TRUNCATED_TOOL_INPUT,
  tokenUsage = usage(10, 8192),
): LanguageModelV4StreamPart[] {
  return [
    { type: "tool-call", toolCallId, toolName, input },
    {
      type: "finish",
      finishReason: { unified: "length", raw: "max_output_tokens" },
      usage: tokenUsage,
    },
  ];
}

export function multiToolCallChunks(
  calls: readonly { toolCallId: string; toolName: string; input: unknown }[],
  tokenUsage = usage(5, 5),
): LanguageModelV4StreamPart[] {
  return [
    ...calls.map((call) => ({
      type: "tool-call" as const,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: JSON.stringify(call.input),
    })),
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: undefined },
      usage: tokenUsage,
    },
  ];
}

export function streamResult(chunks: LanguageModelV4StreamPart[], chunkDelayInMs?: number) {
  return { stream: simulateReadableStream({ chunks, chunkDelayInMs }) };
}

/**
 * One scripted provider request. Every script that waits ends with an AbortError once its
 * request's signal aborts.
 * hang: never answers. silent: opens a stream that sends `stream-start`, then nothing.
 * stall-after: streams `parts`, then nothing. reply: streams `parts` and closes, and a generate
 * call answers with their text.
 */
export type CallScript =
  | { readonly kind: "hang" }
  | { readonly kind: "silent" }
  | { readonly kind: "stall-after"; readonly parts: readonly LanguageModelV4StreamPart[] }
  | { readonly kind: "reply"; readonly parts: readonly LanguageModelV4StreamPart[] };

/**
 * `signals[i]` is the abortSignal the i-th request received. A request past the end of
 * `scripts` throws, so an unexpected retry fails the test.
 */
export function scriptedModel(scripts: readonly CallScript[]): {
  readonly model: MockLanguageModelV4;
  readonly signals: readonly AbortSignal[];
} {
  const signals: AbortSignal[] = [];
  const begin = (options: LanguageModelV4CallOptions) => {
    const signal = options.abortSignal;
    if (signal === undefined)
      throw new Error("scriptedModel needs an abortSignal on every request");
    const script = scripts[signals.length];
    if (script === undefined) {
      throw new Error(`scriptedModel has no script for request ${signals.length + 1}`);
    }
    signals.push(signal);
    return { script, signal };
  };
  const untilAborted = (signal: AbortSignal) =>
    new Promise<never>((_, reject) => {
      onAbort(signal, () => reject(abortedError(signal)));
    });
  const stream = (
    parts: readonly LanguageModelV4StreamPart[],
    signal: AbortSignal,
    closes: boolean,
  ) =>
    new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        if (closes) controller.close();
        else onAbort(signal, () => controller.error(abortedError(signal)));
      },
    });
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const { script, signal } = begin(options);
      switch (script.kind) {
        case "hang":
          return untilAborted(signal);
        case "silent":
          return { stream: stream([{ type: "stream-start", warnings: [] }], signal, false) };
        case "stall-after":
          return { stream: stream(script.parts, signal, false) };
        case "reply":
          return { stream: stream(script.parts, signal, true) };
      }
    },
    doGenerate: async (options) => {
      const { script, signal } = begin(options);
      if (script.kind !== "reply") return untilAborted(signal);
      const text = script.parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : []));
      return {
        content: [{ type: "text", text: text.join("") }],
        finishReason: { unified: "stop", raw: undefined },
        usage: usage(5, 5),
        warnings: [],
      };
    },
  });
  return { model, signals };
}

export function repeatedWriteCalls(turns: number) {
  return Array.from({ length: turns }, (_, i) =>
    streamResult(toolCallChunks(`call-${i}`, "write_file", { path: `a${i}.txt` })),
  );
}

export async function collect(events: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const out: LoopEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

export function makeTools(execute: (input: { path: string }) => Promise<string>): ToolSet {
  return {
    write_file: tool({
      description: "write a file",
      inputSchema: z.object({ path: z.string() }),
      execute,
    }),
  };
}

export const baseMessages: ModelMessage[] = [{ role: "user", content: "do the task" }];
