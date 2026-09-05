import { describe, expect, test } from "bun:test";
import { WRITE_TOOL_NAMES, toolDefinitions } from "../../src/provider/tools";
import {
  ASK_PLAN_QUESTIONS_TOOL_NAME,
  MAX_PLAN_OPTIONS,
  MAX_PLAN_QUESTIONS,
  MIN_PLAN_OPTIONS,
  SUBMIT_PLAN_TOOL_NAME,
  askPlanQuestionsSchema,
  stripWriteTools,
  submitPlanSchema,
  withPlanTools,
} from "../../src/plan/tools";

describe("askPlanQuestionsSchema", () => {
  const question = { id: "q1", prompt: "Which?", options: ["a", "b"] };

  test("accepts 1–3 questions with 2–6 options", () => {
    expect(askPlanQuestionsSchema.safeParse({ questions: [question] }).success).toBe(true);
    expect(
      askPlanQuestionsSchema.safeParse({
        questions: [question, { ...question, id: "q2" }, { ...question, id: "q3" }],
      }).success,
    ).toBe(true);
  });

  test("rejects more than 3 questions", () => {
    expect(MAX_PLAN_QUESTIONS).toBe(3);
    expect(
      askPlanQuestionsSchema.safeParse({
        questions: [
          question,
          { ...question, id: "q2" },
          { ...question, id: "q3" },
          { ...question, id: "q4" },
        ],
      }).success,
    ).toBe(false);
  });

  test("rejects an empty questions list", () => {
    expect(askPlanQuestionsSchema.safeParse({ questions: [] }).success).toBe(false);
  });

  test("rejects fewer than 2 or more than 6 options", () => {
    expect(MIN_PLAN_OPTIONS).toBe(2);
    expect(MAX_PLAN_OPTIONS).toBe(6);
    expect(
      askPlanQuestionsSchema.safeParse({
        questions: [{ id: "q1", prompt: "Which?", options: ["only"] }],
      }).success,
    ).toBe(false);
    expect(
      askPlanQuestionsSchema.safeParse({
        questions: [{ id: "q1", prompt: "Which?", options: ["a", "b", "c", "d", "e", "f", "g"] }],
      }).success,
    ).toBe(false);
  });
});

describe("submitPlanSchema", () => {
  test("requires a non-empty title and markdown", () => {
    expect(submitPlanSchema.safeParse({ title: "T", markdown: "body" }).success).toBe(true);
    expect(submitPlanSchema.safeParse({ title: "", markdown: "body" }).success).toBe(false);
    expect(submitPlanSchema.safeParse({ title: "T", markdown: "" }).success).toBe(false);
  });
});

describe("stripWriteTools / withPlanTools", () => {
  test("stripWriteTools drops every WRITE_TOOL_NAMES key and leaves the rest", () => {
    const stripped = stripWriteTools(toolDefinitions);
    for (const name of WRITE_TOOL_NAMES) {
      expect(stripped[name]).toBeUndefined();
    }
    expect(stripped.read_file).toBeDefined();
  });

  test("withPlanTools adds the two plan tools", () => {
    const tools = withPlanTools(stripWriteTools(toolDefinitions), {
      askQuestions: async () => ({ cancelled: true }),
      configDir: "/tmp",
    });
    expect(tools[ASK_PLAN_QUESTIONS_TOOL_NAME]).toBeDefined();
    expect(tools[SUBMIT_PLAN_TOOL_NAME]).toBeDefined();
    expect(tools.write_file).toBeUndefined();
  });
});
