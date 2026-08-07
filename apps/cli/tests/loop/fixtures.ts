// The fixtures loop.test.ts and loop.tools.test.ts both build their mock models out of. Split
// out when loop.test.ts crossed 1000 lines: the two files exercise different halves of runLoop
// (the stream and its errors; tool dispatch, permissions and cancellation) but drive it with the
// same chunk builders, so a second copy of these would be the thing that drifts.
import { simulateReadableStream, tool, type ModelMessage, type ToolSet } from "ai";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { z } from "zod";
import type { LoopEvent } from "../../src/loop/loop";

export function usage(inputTotal: number, outputTotal: number) {
  return {
    inputTokens: { total: inputTotal, noCache: inputTotal, cacheRead: undefined, cacheWrite: undefined },
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

export function streamResult(chunks: LanguageModelV4StreamPart[], chunkDelayInMs?: number) {
  return { stream: simulateReadableStream({ chunks, chunkDelayInMs }) };
}

// A model that calls write_file on every one of `turns` turns and never answers with text. What a
// model stuck retrying a denied call actually looks like, without depending on a real one to be
// stubborn.
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
