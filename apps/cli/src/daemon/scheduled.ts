import { join } from "node:path";
import { findCatalogEntry } from "@seri/model-catalog";
import type { ModelMessage } from "ai";
import { loadAgentsFile as loadAgentsFileReal } from "../agents/loadAgentsFile";
import { buildSystemPrompt } from "../agents/systemPrompt";
import { createCheckpointer } from "../checkpoint/checkpoint";
import type { CliDeps, RunContext } from "../cli";
import { printWarning } from "../cli/output";
import { loadVerifyConfig } from "../config/config";
import { createMcpClients, createSessionDial } from "../mcp/client";
import { createArchivistState } from "../memory/archivist";
import { loadMemory } from "../memory/store";
import { loadDenials } from "../permissions/store";
import { resolveDefaultModel } from "../provider/defaults";
import { createRulesState } from "../rules/match";
import { driveLoop } from "../runtime/drive";
import { createSessionTrajectory, type RunSession, resolveModelRoute } from "../runtime/prepare";
import type { SessionDatabase } from "../session/database";
import { saveSession } from "../session/session";
import { builtinRegistry } from "../subagents/registry";
import { assertScheduledToolset, type RunScheduled } from "./scheduler";

export function createRunScheduled(opts: {
  configDir: string;
  sessionsDir: string;
  permissionsDir: string;
  deps: CliDeps;
  database: SessionDatabase;
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



      systemPrompt: buildSystemPrompt({
        agentsContent: loadAgentsFileFn(input.session.cwd),
        skills: [],
        rules: [],
        composeSubagents: false,
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
      pathDenials: loadDenials(opts.permissionsDir, onWarning),
      catalog,
      catalogEntry,
      route,
      plan,
      checkpointer: live,
      verifyConfig: loadVerifyConfig(opts.configDir),
      memory: loadMemory({ configDir: opts.configDir, worktree: session.cwd }),


      agents: builtinRegistry(),
      skills: new Map(),
      rules: new Map(),
      rulesState: createRulesState(),





      hooks: { registry: new Map() },



      mcp: new Map(),
      mcpClients: createMcpClients(createSessionDial(opts.configDir)),
      trajectory: createSessionTrajectory(session, opts.configDir, onWarning, opts.database),
      database: opts.database,
      preMountMessages: [],
    };
    const ctx: RunContext = {
      resuming: true,
      resumeId: session.id,
      taskText: "",
      sessionsDir: opts.sessionsDir,
      checkpointsDir,
      permissionsDir: opts.permissionsDir,
      configDir: opts.configDir,
      cwd: session.cwd,
      database: opts.database,
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
          saveSession(next, opts.sessionsDir, opts.database);
        },
        async () => "no",
        createArchivistState(session),
        undefined,
        {
          bindProcessCancel: false,
          composeSubagents: false,
          runArchivist: false,
          composeAskUser: false,
          askOutsideFs: false,
        },
      );
    } catch (caught) {
      return { error: caught instanceof Error ? caught.message : String(caught) };
    }
    if (error !== undefined) return { error };
    return { response };
  };
}
