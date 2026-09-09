import type { LanguageModel, LanguageModelUsage, ModelMessage } from "ai";
import {
  type CompactionSummary,
  compactMessages,
  DEFAULT_PRESERVE_RECENT_TOKENS,
  findSafeEvictionBoundary,
  isCompactSummaryMessage,
} from "./compaction";

export type CompactCursor =
  | { readonly status: "full" }
  | {
      readonly status: "compacted";
      readonly windowStart: number;
      readonly recap: ModelMessage;
    };

export const FULL_WINDOW: CompactCursor = { status: "full" };

export type ConversationSnapshot = {
  readonly messages: ModelMessage[];
  readonly compact: CompactCursor;
};

export type Conversation = {
  readonly archive: ModelMessage[];
  compact: CompactCursor;
};

export function parseCompactCursor(
  compact: CompactCursor | undefined,
  archiveLength: number,
): CompactCursor {
  if (compact === undefined || compact.status === "full") return FULL_WINDOW;
  if (compact.windowStart < 1 || compact.windowStart > archiveLength) {
    throw new Error(
      `compact windowStart ${compact.windowStart} is outside archive length ${archiveLength}`,
    );
  }
  if (!isCompactSummaryMessage(compact.recap)) {
    throw new Error("compact recap must be a structured compacted-history user message");
  }
  return compact;
}

export function createConversation(
  messages: readonly ModelMessage[],
  compact: CompactCursor | undefined = FULL_WINDOW,
): Conversation {
  const archive = [...messages];
  return { archive, compact: parseCompactCursor(compact, archive.length) };
}

export function windowOf(conversation: Conversation): ModelMessage[] {
  if (conversation.compact.status === "full") return conversation.archive;
  return [
    conversation.compact.recap,
    ...conversation.archive.slice(conversation.compact.windowStart),
  ];
}

export function snapshotOf(conversation: Conversation): ConversationSnapshot {
  return { messages: [...conversation.archive], compact: conversation.compact };
}

export function rewindToOf(conversation: Conversation): number {
  if (conversation.archive.length === 0) {
    throw new Error("rewindTo is undefined on an empty archive");
  }
  return conversation.archive.length - 1;
}

export function rewindContextOf(conversation: Conversation): { rewindTo: number } {
  return { rewindTo: rewindToOf(conversation) };
}

export function advanceCursor(
  compact: CompactCursor,
  recap: ModelMessage,
  windowEvictBoundary: number,
  archiveLength: number,
): CompactCursor {
  if (windowEvictBoundary < 1) {
    throw new Error(`evict boundary ${windowEvictBoundary} must be at least 1`);
  }
  if (!isCompactSummaryMessage(recap)) {
    throw new Error("compact recap must be a structured compacted-history user message");
  }
  const archiveEvicted = compact.status === "full" ? windowEvictBoundary : windowEvictBoundary - 1;
  const windowStart = (compact.status === "full" ? 0 : compact.windowStart) + archiveEvicted;
  return parseCompactCursor({ status: "compacted", windowStart, recap }, archiveLength);
}

export function applyRecap(
  conversation: Conversation,
  recap: ModelMessage,
  windowEvictBoundary: number,
): void {
  conversation.compact = advanceCursor(
    conversation.compact,
    recap,
    windowEvictBoundary,
    conversation.archive.length,
  );
}

export function truncateArchive(conversation: Conversation, endExclusive: number): void {
  if (endExclusive < 0 || endExclusive > conversation.archive.length) {
    throw new Error(
      `truncate end ${endExclusive} is outside archive length ${conversation.archive.length}`,
    );
  }
  if (
    conversation.compact.status === "compacted" &&
    conversation.compact.windowStart > endExclusive
  ) {
    throw new Error("rewind cannot cross the compacted prefix");
  }
  conversation.archive.splice(endExclusive);
}

export async function compactConversation(
  conversation: Conversation,
  model: LanguageModel,
  signal: AbortSignal | undefined,
  opts: {
    preserveRecentTokens?: number;
    stream?: boolean;
    customInstructions?: string;
    temperature?: number;
    seed?: number;
    onBeforeCompact?: () => Promise<void>;
  } = {},
): Promise<
  | { status: "skipped" }
  | {
      status: "ok";
      summary: CompactionSummary;
      evictedCount: number;
      usage: LanguageModelUsage;
      retries: number;
      tokensBefore: number;
    }
> {
  const preserveRecentTokens = opts.preserveRecentTokens ?? DEFAULT_PRESERVE_RECENT_TOKENS;
  const window = windowOf(conversation);
  const evictBoundary = findSafeEvictionBoundary(window, preserveRecentTokens);
  if (evictBoundary === null) return { status: "skipped" };
  if (opts.onBeforeCompact !== undefined) await opts.onBeforeCompact();
  const compacted = await compactMessages(window, model, evictBoundary, signal, {
    stream: opts.stream,
    customInstructions: opts.customInstructions,
    temperature: opts.temperature,
    seed: opts.seed,
  });
  const recap = compacted.messages[0];
  if (recap === undefined) {
    throw new Error("compactMessages returned an empty window");
  }
  applyRecap(conversation, recap, compacted.evictedCount);
  return {
    status: "ok",
    summary: compacted.summary,
    evictedCount: compacted.evictedCount,
    usage: compacted.usage,
    retries: compacted.retries,
    tokensBefore: compacted.tokensBefore,
  };
}
