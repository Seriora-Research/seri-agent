import { describe, expect, test } from "bun:test";
import { assertReplyMatchesPrompt, parseAskPrompt } from "../../src/ask-user/parse";
import type { AskPrompt } from "../../src/ask-user/types";

const valid = { prompt: "Which auth?", choices: ["cookies", "JWT"] };

describe("parseAskPrompt", () => {
  test("accepts 2–6 unique choices and defaults allowOther to true", () => {
    expect(parseAskPrompt(valid)).toEqual({
      ok: true,
      prompt: { prompt: "Which auth?", choices: ["cookies", "JWT"], allowOther: true },
    });
    expect(parseAskPrompt({ ...valid, allowOther: false }).ok).toBe(true);
    expect(
      parseAskPrompt({
        prompt: "Pick",
        choices: ["a", "b", "c", "d", "e", "f"],
      }).ok,
    ).toBe(true);
  });

  test("trims labels and rejects an empty prompt", () => {
    expect(parseAskPrompt({ prompt: "  Which?  ", choices: [" a ", "b"] })).toEqual({
      ok: true,
      prompt: { prompt: "Which?", choices: ["a", "b"], allowOther: true },
    });
    expect(parseAskPrompt({ prompt: "   ", choices: ["a", "b"] }).ok).toBe(false);
  });

  test("rejects 1 choice, 7 choices, and duplicates after trim", () => {
    expect(parseAskPrompt({ prompt: "Q", choices: ["only"] }).ok).toBe(false);
    expect(parseAskPrompt({ prompt: "Q", choices: ["a", "b", "c", "d", "e", "f", "g"] }).ok).toBe(
      false,
    );
    expect(parseAskPrompt({ prompt: "Q", choices: ["JWT", " JWT "] }).ok).toBe(false);
  });
});

describe("assertReplyMatchesPrompt", () => {
  const prompt: AskPrompt = {
    prompt: "Which auth?",
    choices: ["cookies", "JWT"],
    allowOther: true,
  };

  test("accepts a listed pick, trimmed other, and cancel", () => {
    expect(assertReplyMatchesPrompt(prompt, { outcome: "picked", choice: "JWT" })).toEqual({
      outcome: "picked",
      choice: "JWT",
    });
    expect(assertReplyMatchesPrompt(prompt, { outcome: "other", text: "  mTLS  " })).toEqual({
      outcome: "other",
      text: "mTLS",
    });
    expect(assertReplyMatchesPrompt(prompt, { outcome: "cancelled" })).toEqual({
      outcome: "cancelled",
    });
  });

  test("rejects an unknown pick, empty other, and other when disabled", () => {
    expect(assertReplyMatchesPrompt(prompt, { outcome: "picked", choice: "oauth" }).outcome).toBe(
      "invalid",
    );
    expect(assertReplyMatchesPrompt(prompt, { outcome: "other", text: "  " }).outcome).toBe(
      "invalid",
    );
    expect(
      assertReplyMatchesPrompt({ ...prompt, allowOther: false }, { outcome: "other", text: "x" })
        .outcome,
    ).toBe("invalid");
  });
});
