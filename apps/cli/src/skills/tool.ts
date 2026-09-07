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







export const SKILL_TOOL_NAME = "skill";

const DESCRIPTION =
  `Load one of this project's named skills and then follow the instructions it returns. The ` +
  `"# Skills" section of your system prompt lists every skill by name and says what each is for; ` +
  `their actual instructions are NOT in your prompt and this tool is the only way to read them. ` +
  `Call this when a task matches a skill's description, before starting the task. "arguments" is ` +
  `the text the skill's instructions are about, when it takes any — pass the user's own words.`;


export function withSkills(tools: ToolSet, skills: SkillRegistry): ToolSet {
  const visible = modelVisibleSkills(skills);


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




        const spec = visible.find((skill) => skill.name === args.name);
        if (spec === undefined) {
          throw new Error(`no skill named "${args.name}" is available this session`);
        }
        try {
          return substituteSkillArgs(readSkillBody(spec), args.arguments ?? "");
        } catch (err) {



          throw new Error(`could not load the "${spec.name}" skill: ${messageOf(err)}`);
        }
      },
    }),
  };
}
