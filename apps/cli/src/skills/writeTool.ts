import { tool } from "ai";
import { z } from "zod";
import { commandByName } from "../cli/commandCatalog";
import { scanForInjection } from "../memory/injectionScan";
import { isRoutableRole } from "../subagents/routes";
import { existingSkillBody, type PendingSkill, stagePendingSkill } from "./pending";

// A skill body is read on demand, so it costs nothing per turn the way a memory entry does and
// needs no cap for that reason. This one is a different guard: an agent-authored file that grows
// without bound is a runaway write, and a procedure that cannot be stated in this much text is one
// a human should be writing rather than approving.
export const MAX_SKILL_BODY_LENGTH = 8_000;
const MAX_SKILL_DESCRIPTION_LENGTH = 500;

// The same shape parseSkillFile enforces on load. Checked here too rather than only there, so the
// archivist is told at write time instead of staging a file that would be skipped on the next
// session start.
const NAME_SHAPE = /^[a-z0-9][a-z0-9-]*$/;

export const skillWriteInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  body: z.string().min(1),
  reason: z.string().min(1),
  durable: z.boolean(),
});

const DESCRIPTION =
  `Propose a reusable procedure as a skill: a named set of instructions that a future session can ` +
  `load by name when the same kind of work comes up again. Use it for a sequence that was hard to ` +
  `work out and would be worth following again — the steps, the order, the checks, the traps — ` +
  `not for a fact about this project, which is what memory_write is for. "body" is the ` +
  `instructions themselves, addressed to the agent that will follow them; write "$ARGUMENTS" ` +
  `where the task's own subject belongs. Nothing is written to disk: the skill is staged for a ` +
  `human to read and approve first.`;

/**
 * The archivist's second write path, alongside memory_write, and the only one seri has that
 * produces a whole file. Same discipline the memory write already carries: an injection scan
 * before anything is touched, required `reason`/`durable` provenance, and staging behind a
 * default-on preview rather than a direct write.
 *
 * Unlike memory_write there is no approval-off branch. A memory entry is one line into a file
 * outside the repository; a skill is a standing artifact that lands inside the user's own tree and
 * steers later sessions, so it always waits for a human.
 */
export function makeSkillWriteTool(
  ctx: { configDir: string; worktree: string },
  // The same seam makeMemoryWriteTool carries, for the same reason: the caller names what this run
  // staged from the records themselves rather than diffing a queue two sessions can write to.
  opts: { onStaged?: (staged: PendingSkill) => void } = {},
) {
  return tool({
    description: DESCRIPTION,
    inputSchema: skillWriteInputSchema,
    execute: async (args) => {
      const name = args.name.trim().toLowerCase();
      if (!NAME_SHAPE.test(name)) {
        throw new Error(
          `skill_write refused: "${name}" is not a usable skill name (lowercase letters, digits and "-"). Nothing was staged.`,
        );
      }
      if (isRoutableRole(name) || commandByName(`/${name}`) !== undefined) {
        throw new Error(
          `skill_write refused: "${name}" is already a built-in agent or a slash command, so a skill by that name could never load. Nothing was staged.`,
        );
      }
      if (args.description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
        throw new Error(
          `skill_write refused: "description" is ${args.description.length} characters, over the ${MAX_SKILL_DESCRIPTION_LENGTH}-character limit. It is what a future session reads to decide whether to load this, so make it one or two sentences. Nothing was staged.`,
        );
      }
      if (args.body.length > MAX_SKILL_BODY_LENGTH) {
        throw new Error(
          `skill_write refused: "body" is ${args.body.length} characters, over the ${MAX_SKILL_BODY_LENGTH}-character limit. Nothing was staged.`,
        );
      }

      // Scanned across every field the model wrote, together, BEFORE anything is staged — the same
      // ordering memory_write uses, and for the same reason: the queue is reviewed by a human who
      // should never be shown a credential or a prompt-injection attempt to approve.
      const scan = scanForInjection(
        [args.name, args.description, args.body, args.reason].join("\n"),
      );
      if (!scan.ok) {
        throw new Error(
          `skill_write refused: this looks like ${scan.category} (${scan.rule}): ${scan.reason}. Nothing was staged.`,
        );
      }

      const staged = stagePendingSkill(
        {
          name,
          description: args.description,
          body: args.body,
          reason: args.reason,
          durable: args.durable,
        },
        ctx,
        new Date(),
      );
      opts.onStaged?.(staged);
      // Told at write time, not discovered at approval time: the human's diff will show a replace,
      // and the archivist should know it is proposing one so it can decide whether it really means
      // to supersede what is already there.
      const replaces = existingSkillBody(ctx.worktree, name) !== undefined;
      return {
        staged: true,
        id: staged.id,
        name: staged.name,
        replacesExisting: replaces,
        message: `Staged for human review: /skills diff ${staged.id}`,
      };
    },
  });
}
