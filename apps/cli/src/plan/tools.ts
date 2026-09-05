import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { WRITE_TOOL_NAMES } from "../provider/tools";
import { writePlanFile } from "./files";
import type { PlanAnswers, PlanQuestion } from "./mode";

export const ASK_PLAN_QUESTIONS_TOOL_NAME = "ask_plan_questions";
export const SUBMIT_PLAN_TOOL_NAME = "submit_plan";

export const MAX_PLAN_QUESTIONS = 3;
export const MIN_PLAN_OPTIONS = 2;
export const MAX_PLAN_OPTIONS = 6;

const questionSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  options: z.array(z.string().min(1)).min(MIN_PLAN_OPTIONS).max(MAX_PLAN_OPTIONS),
});

export const askPlanQuestionsSchema = z.object({
  questions: z.array(questionSchema).min(1).max(MAX_PLAN_QUESTIONS),
});

export const submitPlanSchema = z.object({
  title: z.string().min(1),
  markdown: z.string().min(1),
});

export type PlanModeToolOpts = {
  askQuestions: (questions: readonly PlanQuestion[], signal?: AbortSignal) => Promise<PlanAnswers>;
  configDir: string;
};

export function stripWriteTools(tools: ToolSet): ToolSet {
  const next = { ...tools };
  for (const name of WRITE_TOOL_NAMES) delete next[name];
  return next;
}

export function withPlanTools(tools: ToolSet, opts: PlanModeToolOpts): ToolSet {
  return {
    ...tools,
    [ASK_PLAN_QUESTIONS_TOOL_NAME]: tool({
      description:
        "Ask the user up to 3 multiple-choice questions before researching a plan. Each question " +
        "needs 2–6 options. The user can also type a custom answer and optional free-text notes. " +
        "Skip this tool when the request is already clear.",
      inputSchema: askPlanQuestionsSchema,
      execute: async ({ questions }, { abortSignal }) => opts.askQuestions(questions, abortSignal),
    }),
    [SUBMIT_PLAN_TOOL_NAME]: tool({
      description:
        "Submit the finished plan. The harness writes it to the profile's plans directory and " +
        "returns the path. This is the only write available in plan mode.",
      inputSchema: submitPlanSchema,
      execute: ({ title, markdown }) => writePlanFile(opts.configDir, title, markdown),
    }),
  };
}
