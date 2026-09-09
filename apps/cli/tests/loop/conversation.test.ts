import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { COMPACT_HISTORY_PREFIX } from "../../src/loop/compaction";
import {
  advanceCursor,
  applyRecap,
  createConversation,
  FULL_WINDOW,
  parseCompactCursor,
  rewindToOf,
  snapshotOf,
  truncateArchive,
  windowOf,
} from "../../src/loop/conversation";

function recap(evicted: number): ModelMessage {
  return {
    role: "user",
    content:
      `${COMPACT_HISTORY_PREFIX} ${evicted} earlier messages condensed]\n` +
      `Goal: g\nProgress: p\nBlockers: b\nNext steps: n`,
  };
}

function archive(count: number): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (let i = 0; i < count; i++) {
    out.push(
      i % 2 === 0 ? { role: "user", content: `u${i}` } : { role: "assistant", content: `a${i}` },
    );
  }
  return out;
}

describe("createConversation", () => {
  test("a missing cursor is a full window that shares the archive array", () => {
    const messages = archive(4);
    const conversation = createConversation(messages);
    expect(conversation.compact).toEqual(FULL_WINDOW);
    expect(windowOf(conversation)).toBe(conversation.archive);
    expect(conversation.archive).toEqual(messages);
    expect(conversation.archive).not.toBe(messages);
  });

  test("a compacted cursor prepends the recap and hides the prefix", () => {
    const messages = archive(6);
    const conversation = createConversation(messages, {
      status: "compacted",
      windowStart: 4,
      recap: recap(4),
    });
    expect(windowOf(conversation)).toEqual([recap(4), ...messages.slice(4)]);
    expect(conversation.archive).toEqual(messages);
  });

  test("windowStart 0 with a recap is illegal", () => {
    expect(() =>
      parseCompactCursor({ status: "compacted", windowStart: 0, recap: recap(1) }, 4),
    ).toThrow("windowStart 0");
  });

  test("a recap that is not a compacted-history user message is illegal", () => {
    expect(() =>
      parseCompactCursor(
        {
          status: "compacted",
          windowStart: 2,
          recap: { role: "user", content: "plain user" },
        },
        4,
      ),
    ).toThrow("structured compacted-history");
  });
});

describe("applyRecap", () => {
  test("first compact leaves the archive byte-identical and shrinks only the window", () => {
    const messages = archive(8);
    const conversation = createConversation(messages);
    applyRecap(conversation, recap(4), 4);
    expect(conversation.archive).toEqual(messages);
    expect(conversation.compact).toEqual({
      status: "compacted",
      windowStart: 4,
      recap: recap(4),
    });
    expect(windowOf(conversation)).toEqual([recap(4), ...messages.slice(4)]);
    expect(snapshotOf(conversation).messages).toEqual(messages);
  });

  test("a later compact maps a window boundary onto archive coordinates by skipping the recap slot", () => {
    const messages = archive(10);
    const first = advanceCursor(FULL_WINDOW, recap(4), 4, messages.length);
    const second = advanceCursor(first, recap(6), 3, messages.length);
    expect(second).toEqual({
      status: "compacted",
      windowStart: 6,
      recap: recap(6),
    });
  });

  test("rewindTo is an archive index, not the window length, after compact", () => {
    const conversation = createConversation(archive(8));
    applyRecap(conversation, recap(4), 4);
    conversation.archive.push({ role: "assistant", content: "tool call" });
    expect(rewindToOf(conversation)).toBe(8);
    expect(windowOf(conversation)).toHaveLength(6);
  });
});

describe("truncateArchive", () => {
  test("refuses a cut inside the compacted prefix", () => {
    const conversation = createConversation(archive(8), {
      status: "compacted",
      windowStart: 4,
      recap: recap(4),
    });
    expect(() => truncateArchive(conversation, 3)).toThrow("compacted prefix");
  });

  test("a cut in the live tail keeps the cursor", () => {
    const conversation = createConversation(archive(8), {
      status: "compacted",
      windowStart: 4,
      recap: recap(4),
    });
    truncateArchive(conversation, 6);
    expect(conversation.archive).toHaveLength(6);
    expect(conversation.compact.status).toBe("compacted");
    if (conversation.compact.status === "compacted") {
      expect(conversation.compact.windowStart).toBe(4);
    }
  });
});
