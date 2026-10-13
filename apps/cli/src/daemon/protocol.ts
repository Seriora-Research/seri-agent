import type { TurnRequest } from "@seri/daemon-client";
import { z } from "zod";
import { ToolSpawnEnv } from "../tools/toolSpawnEnv";

const hasNoNul = (text: string): boolean => !text.includes("\0");

const clientEnvSchema = z.record(z.string().min(1).refine(hasNoNul), z.string().refine(hasNoNul));

export const turnRequestSchema = z.object({
  task: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  permissionMode: z.enum(["read-only", "approve-each"]).optional(),
  permissionPrompts: z.literal("none").optional(),
  env: clientEnvSchema
    .optional()
    .transform((vars) =>
      vars === undefined ? ToolSpawnEnv.inherited : ToolSpawnEnv.exactly(vars),
    ),
});

export const approvalBodySchema = z.object({
  answer: z.enum(["once", "always", "no"]),
});

export type ParsedTurnRequest = z.output<typeof turnRequestSchema>;
export type ParsedApprovalBody = z.infer<typeof approvalBodySchema>;

type Assert<T extends true> = T;
type _EveryClientRequestParses = Assert<
  TurnRequest extends z.input<typeof turnRequestSchema> ? true : false
>;
type _ClientNamesEverySchemaField = Assert<
  keyof z.input<typeof turnRequestSchema> extends keyof TurnRequest ? true : false
>;
