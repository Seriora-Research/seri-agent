import { tool } from "ai";
import { z } from "zod";
import { loadMemoryConfig } from "../config/config";
import { truncate } from "../truncate";
import { scanForInjection } from "./injectionScan";
import { type PendingWrite, stagePendingWrite } from "./pending";
import {
  applyWrite,
  computeWrite,
  type LoadedMemory,
  loadMemoryFile,
  MemoryConflict,
  type MemoryContext,
  type MemoryFile,
  type MemoryScope,
  type MemoryWriteRequest,
  sanitizeMemoryWrite,
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

function linesOf(text: string): string[] {
  return text.length === 0 ? [] : text.split("\n");
}

function shownLinesOf(file: MemoryFile): Set<string> {
  return new Set(file.entries.map((entry) => entry.line));
}

function expectShownLine(
  shown: Set<string>,
  live: MemoryFile,
  req: MemoryWriteRequest,
): MemoryWriteRequest {
  const target = req.target;
  if (req.action === "add" || target === undefined) return req;
  const matches = [...shown].filter((line) => line.includes(target));
  if (matches.length === 0) {
    throw new MemoryConflict(live, `no entry you were shown contains "${truncate(target, 80)}".`);
  }
  if (matches.length > 1) {
    throw new Error(
      `memory_write refused: "${truncate(target, 80)}" appears in ${matches.length} entries; include enough text to identify exactly one.`,
    );
  }
  return { ...req, expect: matches[0] };
}

function applyToShown(shown: Set<string>, before: string, after: string): void {
  const beforeLines = new Set(linesOf(before));
  const afterLines = new Set(linesOf(after));
  for (const line of beforeLines) if (!afterLines.has(line)) shown.delete(line);
  for (const line of afterLines) if (!beforeLines.has(line)) shown.add(line);
}

export function makeMemoryWriteTool(
  ctx: MemoryContext,
  opts: {
    forceStage?: boolean;

    onStaged?: (staged: PendingWrite) => void;
    shown?: LoadedMemory;
  } = {},
) {
  const shown: Record<MemoryScope, Set<string>> | undefined =
    opts.shown === undefined
      ? undefined
      : {
          user: shownLinesOf(opts.shown.user),
          "memory-global": shownLinesOf(opts.shown.global),
          "memory-project": shownLinesOf(opts.shown.project),
        };
  return tool({
    description: DESCRIPTION,
    inputSchema: memoryWriteInputSchema,
    execute: async (args) => {
      const req: MemoryWriteRequest = sanitizeMemoryWrite({
        scope: args.scope,
        action: args.action,
        target: args.target,
        content: args.content,
        reason: args.reason,
        durable: args.durable,
      });
      const scanText = [req.content, req.target, req.reason].filter(Boolean).join("\n");
      const scan = scanForInjection(scanText);
      if (!scan.ok) {
        throw new Error(
          `memory_write refused: this looks like ${scan.category} (${scan.rule}): ${scan.reason}. ` +
            `Nothing was written or staged.`,
        );
      }
      const today = new Date().toISOString().slice(0, 10);

      try {
        const live = loadMemoryFile(req.scope, ctx);
        const resolved = shown === undefined ? req : expectShownLine(shown[req.scope], live, req);
        computeWrite(live, resolved, today);

        if (opts.forceStage === true || loadMemoryConfig(ctx.configDir).approvalRequired) {
          const staged = stagePendingWrite(resolved, ctx, new Date());
          opts.onStaged?.(staged);
          return {
            staged: true,
            id: staged.id,
            scope: staged.scope,
            message: `Staged for human review: /memory diff ${staged.id}`,
          };
        }
        const result = applyWrite(resolved, ctx, today);
        if (shown !== undefined) applyToShown(shown[req.scope], result.before, result.after);
        return {
          staged: false,
          path: result.path,
          message: "Written directly (approval gate is off).",
        };
      } catch (error) {
        if (shown !== undefined && error instanceof MemoryConflict) {
          shown[error.file.scope] = shownLinesOf(error.file);
        }
        throw error;
      }
    },
  });
}
