import type { ModelCatalog, ModelProvider } from "@seri/model-catalog";
import type { LanguageModel, ModelMessage } from "ai";
import { type ArchivistReport, createArchivistState, runArchivist } from "../memory/archivist";
import type { MemoryContext } from "../memory/store";
import type { SessionDatabase } from "../session/database";
import type { SessionState } from "../session/session";

export async function flushIdleArchivist(args: {
  database: SessionDatabase;
  sessionId: string;
  ctx: MemoryContext;
  model: LanguageModel;
  route: { model: string; provider: ModelProvider };
  catalog: ModelCatalog;
  contextWindow: number | undefined;
  signal: AbortSignal;
  onWarning: (message: string) => void;
  runLoop?: Parameters<typeof runArchivist>[0]["runLoop"];
}): Promise<ArchivistReport | undefined> {
  const session = args.database.loadSession<ModelMessage>(args.sessionId);
  if (session === undefined) return undefined;
  const cursor = args.database.getArchivistCursor(args.sessionId);
  const state = createArchivistState(session, cursor);
  const report = await runArchivist({
    state,
    trigger: "idle-timeout",
    ctx: args.ctx,
    model: args.model,
    route: args.route,
    catalog: args.catalog,
    contextWindow: args.contextWindow,
    signal: args.signal,
    onWarning: args.onWarning,
    forceStage: true,
    runLoop: args.runLoop,
  });
  args.database.setArchivistCursor(args.sessionId, state.messageCursor);
  return report;
}

export function sessionMemoryContext(session: SessionState, configDir: string): MemoryContext {
  return { configDir, worktree: session.cwd };
}
