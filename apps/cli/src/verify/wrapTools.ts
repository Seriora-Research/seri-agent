import type { ToolExecutionOptions, ToolSet } from "ai";
import { basename } from "node:path";
import { buildFileChange, isFileChangeView } from "../fileChange";
import type { CheckOutcome, WriteFileResult } from "./outcome";
import { runCheck as runCheckReal } from "./run";








const VERIFIED_TOOL = "write_file";

const DISABLED: CheckOutcome = { status: "unavailable", reason: "verification is disabled" };

export type VerifyDeps = {


  enabled?: boolean;

  command?: string;
  runCheck?: typeof runCheckReal;
};









export function withVerification(tools: ToolSet, deps: VerifyDeps = {}): ToolSet {
  const runCheck = deps.runCheck ?? runCheckReal;
  const enabled = deps.enabled ?? true;

  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => {
      const execute = definition.execute;


      if (name !== VERIFIED_TOOL || execute === undefined) return [name, definition];

      return [
        name,
        {
          ...definition,
          execute: async (
            args: unknown,
            options: ToolExecutionOptions<Record<string, unknown>>,
          ) => {


            const produced = await execute(args, options);



            const { path, content } = args as { path: string; content: string };




            const verification = enabled
              ? await runCheck(deps.command, path, options.abortSignal)
              : DISABLED;
            const producedRecord =
              produced !== null && typeof produced === "object" && !Array.isArray(produced)
                ? (produced as Record<string, unknown>)
                : {};
            const previous =
              producedRecord.previous === null || typeof producedRecord.previous === "string"
                ? (producedRecord.previous ?? "")
                : undefined;
            const change = isFileChangeView(producedRecord.change)
              ? producedRecord.change
              : typeof content === "string" && previous !== undefined
                ? buildFileChange(`Write ${basename(path)}`, previous, content, { path })
                : undefined;
            return {
              written: true,
              verification,
              ...(change === undefined ? {} : { change }),
            } satisfies WriteFileResult;
          },
        },
      ];
    }),
  ) as ToolSet;
}
