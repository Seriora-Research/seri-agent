import { join } from "node:path";
import { findCatalogEntry } from "@seri/model-catalog";
import type { ModelMessage } from "ai";
import { loadAgentsFile as loadAgentsFileReal } from "../agents/loadAgentsFile";
import { buildSystemPrompt } from "../agents/systemPrompt";
import { createCheckpointer } from "../checkpoint/checkpoint";
import type { CliDeps, RunContext } from "../cli";
import { printWarning } from "../cli/output";
import { loadVerifyConfig } from "../config/config";
import { createArchivistState } from "../memory/archivist";
import { loadMemory } from "../memory/store";
import { resolveDefaultModel } from "../provider/defaults";
import { driveLoop } from "../runtime/drive";
import { createSessionTrajectory, type RunSession, resolveModelRoute } from "../runtime/prepare";
import { saveSession } from "../session/session";
import { builtinRegistry } from "../subagents/registry";
import { assertScheduledToolset, type RunScheduled } from "./scheduler";

export function createRunScheduled(opts: {
  configDir: string;
  sessionsDir: string;
  deps: CliDeps;
}): RunScheduled {
  return async (input) => {
    assertScheduledToolset(input.tools);
    const loadAgentsFileFn = opts.deps.loadAgentsFile ?? loadAgentsFileReal;
    const requested = resolveDefaultModel(opts.configDir);
    const { model, route, catalog, plan } = await resolveModelRoute(
      requested,
      opts.configDir,
      input.session.id,
      opts.deps,
    );
    const catalogEntry = findCatalogEntry(catalog, route.model, route.provider);
    const session: RunSession = {
      ...input.session,
      messages: input.session.messages as ModelMessage[],
      // No skills, deliberately, on the same rule the `agents: builtinRegistry()` line below
      // states: an unattended run gets a strictly smaller surface than an attended one, and a
      // skill file a human never saw must not steer it.
      systemPrompt: buildSystemPrompt({
        agentsContent: loadAgentsFileFn(input.session.cwd),
        skills: [],
      }),
      model: route.model,
      provider: route.provider,
      permissionMode: input.policy.permissionMode,
    };
    const onWarning = (message: string) => printWarning(message);
    const checkpointsDir = join(opts.configDir, "checkpoints");
    const live = createCheckpointer({
      storeDir: checkpointsDir,
      worktree: session.cwd,
      sessionId: session.id,
      cwd: session.cwd,
      onWarning,
    });
    const prepared = {
      session,
      storeDir: checkpointsDir,
      tools: input.tools,
      model,
      permissionMode: input.policy.permissionMode,
      worktree: session.cwd,
      allowedTools: input.policy.allowedTools,
      catalog,
      catalogEntry,
      route,
      plan,
      checkpointer: live,
      verifyConfig: loadVerifyConfig(opts.configDir),
      memory: loadMemory({ configDir: opts.configDir, worktree: session.cwd }),
      // Built-ins only, no disk read: this path passes composeSubagents: false, so the dispatch
      // tool never exists here and a scheduled run must not load agent files a human never saw.
      agents: builtinRegistry(),
      skills: new Map(),
      trajectory: createSessionTrajectory(session, opts.configDir, onWarning),
      preMountMessages: [],
    };
    const ctx: RunContext = {
      resuming: true,
      resumeId: session.id,
      taskText: "",
      sessionsDir: opts.sessionsDir,
      checkpointsDir,
      permissionsDir: opts.configDir,
      configDir: opts.configDir,
      cwd: session.cwd,
    };

    let response = "";
    let error: string | undefined;
    try {
      await driveLoop(
        prepared,
        ctx,
        opts.deps,
        500,
        (event) => {
          if (event.type === "text-delta") response += event.text;
          if (event.type === "error") error = event.error;
        },
        () => input.policy.permissionMode,
        (next) => {
          input.session.messages = next.messages;
          saveSession(next, opts.sessionsDir);
        },
        async () => "no",
        createArchivistState(session),
        undefined,
        { bindProcessCancel: false, composeSubagents: false, runArchivist: false },
      );
    } catch (caught) {
      return { error: caught instanceof Error ? caught.message : String(caught) };
    }
    if (error !== undefined) return { error };
    return { response };
  };
}
