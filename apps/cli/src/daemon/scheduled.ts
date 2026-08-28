import type { ModelMessage } from "ai";
import { loadAgentsFile as loadAgentsFileReal } from "../agents/loadAgentsFile";
import { buildSystemPrompt } from "../agents/systemPrompt";
import type { CliDeps } from "../cli";
import { runLoop as runLoopReal } from "../loop/loop";
import { resolveDefaultModel } from "../provider/defaults";
import { resolveModelRoute } from "../runtime/prepare";
import { saveSession } from "../session/session";
import { type RunScheduled, assertScheduledToolset } from "./scheduler";

export function createRunScheduled(opts: {
  configDir: string;
  sessionsDir: string;
  deps: CliDeps;
}): RunScheduled {
  return async (input) => {
    assertScheduledToolset(input.tools);
    const loadAgentsFileFn = opts.deps.loadAgentsFile ?? loadAgentsFileReal;
    const requested = resolveDefaultModel(opts.configDir);
    const { model, route, catalog } = await resolveModelRoute(
      requested,
      opts.configDir,
      input.session.id,
      opts.deps,
    );
    const runLoopFn = opts.deps.runLoop ?? runLoopReal;
    const system = buildSystemPrompt(loadAgentsFileFn(input.session.cwd));
    let response = "";
    try {
      for await (const event of runLoopFn({
        model,
        tools: input.tools,
        messages: input.session.messages as ModelMessage[],
        permissionMode: input.policy.permissionMode,
        allowedTools: [...input.policy.allowedTools],
        system,
        maxIterations: 500,
        provider: route.provider,
        modelId: route.model,
        catalog,
      })) {
        if (event.type === "text-delta") response += event.text;
        if (event.type === "messages-updated") {
          input.session.messages = event.messages;
          saveSession(input.session, opts.sessionsDir);
        }
        if (event.type === "error") {
          return { error: event.error };
        }
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    saveSession(input.session, opts.sessionsDir);
    return { response };
  };
}
