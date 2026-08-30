import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { messageOf } from "../errors";
import {
  modelVisibleSkills,
  readSkillBody,
  type SkillRegistry,
  substituteSkillArgs,
} from "./registry";

// Not a key of `toolDefinitions` (provider/tools.ts), on the same terms DISPATCH_TOOL_NAME is not:
// `ToolName` is derived from that object's keys, so no subagent's grant can ever name this, and a
// child cannot load a skill into its own context. It is also not a WRITE_TOOL_NAME, so the
// permission gate allows it in every mode — correct, because loading a skill reads one file the
// user themselves put under `.seri/skills/` and writes nothing.
export const SKILL_TOOL_NAME = "skill";

const DESCRIPTION =
  `Load one of this project's named skills and then follow the instructions it returns. The ` +
  `"# Skills" section of your system prompt lists every skill by name and says what each is for; ` +
  `their actual instructions are NOT in your prompt and this tool is the only way to read them. ` +
  `Call this when a task matches a skill's description, before starting the task. "arguments" is ` +
  `the text the skill's instructions are about, when it takes any — pass the user's own words.`;

/**
 * Composed only when the session actually has a model-visible skill, which is what keeps the tool
 * list from growing for a user with none — and is also what keeps it off the unattended path for
 * free, since a scheduled run is built with an empty registry and never reaches the branch below.
 */
export function withSkills(tools: ToolSet, skills: SkillRegistry): ToolSet {
  const visible = modelVisibleSkills(skills);
  // Destructured rather than asserted, so `z.enum` gets the non-empty tuple it requires without a
  // cast: an empty registry cannot reach it at all.
  const [first, ...rest] = visible.map((skill) => skill.name);
  if (first === undefined) return tools;

  return {
    ...tools,
    [SKILL_TOOL_NAME]: tool({
      description: DESCRIPTION,
      inputSchema: z.object({
        name: z.enum([first, ...rest]),
        arguments: z.string().optional(),
      }),
      execute: async (args) => {
        // The enum above already refuses every name that is not model-visible, which includes a
        // `disable-model-invocation` skill and one with no description. This lookup re-derives the
        // set rather than closing over a Map keyed by name, so the two can never disagree about
        // what "model-visible" means.
        const spec = visible.find((skill) => skill.name === args.name);
        if (spec === undefined) {
          throw new Error(`no skill named "${args.name}" is available this session`);
        }
        try {
          return substituteSkillArgs(readSkillBody(spec), args.arguments ?? "");
        } catch (err) {
          // A thrown tool error reaches the model as a tool result it reads in the same turn
          // (loop.ts), so a skill whose file was deleted or emptied mid-session says so and the
          // model can carry on without it, rather than silently getting nothing back.
          throw new Error(`could not load the "${spec.name}" skill: ${messageOf(err)}`);
        }
      },
    }),
  };
}
