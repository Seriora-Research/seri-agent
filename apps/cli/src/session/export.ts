import { join } from "node:path";
import { atomicWriteFile } from "../atomicWriteFile";
import { SessionDatabase } from "./database";
import type { SessionState } from "./session";

function headerOf(state: SessionState): Omit<SessionState, "messages"> {
  return {
    id: state.id,
    cwd: state.cwd,
    systemPrompt: state.systemPrompt,
    permissionMode: state.permissionMode,
    ...(state.model !== undefined ? { model: state.model } : {}),
    ...(state.provider !== undefined ? { provider: state.provider } : {}),
    ...(state.reasoningEffort !== undefined ? { reasoningEffort: state.reasoningEffort } : {}),
  };
}

export function exportSessionsToJsonl(configDir: string, outputDir: string): string[] {
  const database = new SessionDatabase(configDir);
  try {
    return database.listSessionIds().map((id) => {
      const state = database.loadSession(id) as SessionState;
      const content = `${[headerOf(state), ...state.messages]
        .map((value) => JSON.stringify(value))
        .join("\n")}\n`;
      const path = join(outputDir, `${id}.jsonl`);
      atomicWriteFile(path, content);
      return path;
    });
  } finally {
    database.close();
  }
}
