import { tool } from "ai";
import { z } from "zod";
import { loadMemoryConfig } from "../config/config";
import { scanForInjection } from "./injectionScan";
import { type PendingWrite, stagePendingWrite } from "./pending";
import {
  applyWrite,
  computeWrite,
  loadMemoryFile,
  type MemoryContext,
  type MemoryWriteRequest,
} from "./store";






export const memoryWriteInputSchema = z.object({
  scope: z.enum(["user", "memory-global", "memory-project"]),
  action: z.enum(["add", "replace", "remove"]),




  target: z.string().min(1).optional(),
  content: z.string().optional(),
  reason: z.string().min(1),
  durable: z.boolean(),
});

const DESCRIPTION =
  `Add, replace, or remove one line in one of seri's three persistent memory files: "user" ` +
  `(applies to every project), "memory-global" (cross-project environment facts), or ` +
  `"memory-project" (this repository only). Each file has a hard character cap; a write that would ` +
  `exceed it is refused and lists every current entry so you can consolidate with "replace" or ` +
  `"remove" instead. "target" identifies the entry to replace or remove — it must match exactly one ` +
  `existing entry. "reason" and "durable" are always required: they travel with the write for a ` +
  `human to review, never with the entry text itself.`;





export function makeMemoryWriteTool(
  ctx: MemoryContext,
  opts: {
    forceStage?: boolean;




    onStaged?: (staged: PendingWrite) => void;
  } = {},
) {
  return tool({
    description: DESCRIPTION,
    inputSchema: memoryWriteInputSchema,
    execute: async (args) => {


      const scanText = [args.content, args.target, args.reason].filter(Boolean).join("\n");
      const scan = scanForInjection(scanText);
      if (!scan.ok) {
        throw new Error(
          `memory_write refused: this looks like ${scan.category} (${scan.rule}): ${scan.reason}. ` +
            `Nothing was written or staged.`,
        );
      }

      const req: MemoryWriteRequest = {
        scope: args.scope,
        action: args.action,
        target: args.target,
        content: args.content,
        reason: args.reason,
        durable: args.durable,
      };
      const today = new Date().toISOString().slice(0, 10);



      computeWrite(loadMemoryFile(req.scope, ctx), req, today);

      if (opts.forceStage === true || loadMemoryConfig(ctx.configDir).approvalRequired) {
        const staged = stagePendingWrite(req, ctx, new Date());
        opts.onStaged?.(staged);
        return {
          staged: true,
          id: staged.id,
          scope: staged.scope,
          message: `Staged for human review: /memory diff ${staged.id}`,
        };
      }
      const result = applyWrite(req, ctx, today);
      return {
        staged: false,
        path: result.path,
        message: "Written directly (approval gate is off).",
      };
    },
  });
}
