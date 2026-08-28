import { z } from "zod";

export const turnRequestSchema = z.object({
  task: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  permissionMode: z.enum(["read-only", "approve-each"]).optional(),
});

export const approvalBodySchema = z.object({
  answer: z.enum(["once", "always", "no"]),
});

export type ParsedTurnRequest = z.infer<typeof turnRequestSchema>;
export type ParsedApprovalBody = z.infer<typeof approvalBodySchema>;
