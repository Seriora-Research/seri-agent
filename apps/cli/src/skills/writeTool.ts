import { tool } from "ai";
import { z } from "zod";
import { commandByName } from "../cli/commandCatalog";
import { scanForInjection } from "../memory/injectionScan";
import { isRoutableRole } from "../subagents/routes";
import { existingSkillBody, type PendingSkill, stagePendingSkill } from "./pending";





export const MAX_SKILL_BODY_LENGTH = 8_000;
const MAX_SKILL_DESCRIPTION_LENGTH = 500;




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


export function makeSkillWriteTool(
  ctx: { configDir: string; worktree: string },


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
