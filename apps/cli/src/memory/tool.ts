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

// `reason` and `durable` are required regardless of `action` — enforced HERE, at the schema level,
// so a call missing either is a schema validation error the model sees before computeWrite ever
// runs, never a computeWrite throw carrying the wrong message for a missing-provenance call.
// Exported (unlike provider/tools.ts's own inline schemas) so tests can call `.safeParse` directly
// — `tool()`'s own `inputSchema` wraps this in the AI SDK's FlexibleSchema, which has no safeParse.
export const memoryWriteInputSchema = z.object({
  scope: z.enum(["user", "memory-global", "memory-project"]),
  action: z.enum(["add", "replace", "remove"]),
  // .min(1): an empty target would match every entry in findUniqueMatch's own `.includes(target)`
  // check (store.ts) — a malformed or hallucinated call with target: "" must fail here, at the
  // schema, rather than silently matching (and, for replace/remove, mutating) whatever the file's
  // one existing entry happens to be.
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

// A factory, not a module-level const like provider/tools.ts's seven: the tool needs a per-dispatch
// configDir/worktree, which toolDefinitions' tools never do. Never added to toolDefinitions itself
// — it reaches exactly one ToolSet, the archivist's own, built directly in memory/archivist.ts's
// runArchivist rather than through subagents/registry.ts (the archivist is not a dispatchable agent).
export function makeMemoryWriteTool(
  ctx: MemoryContext,
  opts: {
    forceStage?: boolean;
    // Handed the record this call staged. The queue directory is shared by every session on the
    // profile, so a caller that instead listed it before and after a run would credit itself with
    // whatever another session staged meanwhile. Never fires on the approval-off branch below:
    // that write lands in the file directly and leaves no queue entry to name.
    onStaged?: (staged: PendingWrite) => void;
  } = {},
) {
  return tool({
    description: DESCRIPTION,
    inputSchema: memoryWriteInputSchema,
    execute: async (args) => {
      // Scanned on content+target+reason together (reason is model-written free text too) BEFORE
      // either the live file or the pending queue is touched.
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
      // Validated against the CURRENT live file before staging too, not only at /memory approve —
      // this is what lets the model see a cap refusal and consolidate in the same turn (store.ts's
      // own comment on computeWrite explains why a throw is what makes that possible).
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
