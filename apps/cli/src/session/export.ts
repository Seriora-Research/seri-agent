import { join } from "node:path";
import { atomicWriteFile } from "../atomicWriteFile";
import { SessionDatabase } from "./database";
import { encodeRecapJson, encodeSessionMessages } from "./redact";
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
    ...(state.compact !== undefined ? { compact: state.compact } : {}),
  };
}

function headerJson(state: SessionState): string {
  const header = headerOf(state);
  if (header.compact?.status !== "compacted") return JSON.stringify(header) ?? "null";
  const recap = JSON.parse(encodeRecapJson(header.compact.recap).json) as unknown;
  return JSON.stringify({ ...header, compact: { ...header.compact, recap } }) ?? "null";
}

export function exportSessionsToJsonl(configDir: string, outputDir: string): string[] {
  const database = new SessionDatabase(configDir);
  try {
    return database.listSessionIds().map((id) => {
      const state = database.loadSession(id) as SessionState;
      const content = `${[headerJson(state), ...encodeSessionMessages(state.messages).json].join("\n")}\n`;
      const path = join(outputDir, `${id}.jsonl`);
      atomicWriteFile(path, content);
      return path;
    });
  } finally {
    database.close();
  }
}
