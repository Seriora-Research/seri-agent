import { randomUUID } from "node:crypto";
import type { CliDeps, RunContext } from "../cli";
import { printWarning } from "../cli/output";
import type { ApprovalPrompt } from "../loop/loop";
import { closeMcpClients } from "../mcp/client";
import { createArchivistState } from "../memory/archivist";
import { driveLoop, exitCodeFromDriveResult } from "../runtime/drive";
import { prepareSession } from "../runtime/prepare";
import type { SessionDatabase } from "../session/database";
import { saveSession } from "../session/session";
import type { ExecuteTurn } from "./sessionManager";

export function createAttendedExecuteTurn(opts: {
  configDir: string;
  sessionsDir: string;
  checkpointsDir: string;
  permissionsDir: string;
  deps: CliDeps;
  database: SessionDatabase;
}): ExecuteTurn {
  return async (input) => {
    const ctx: RunContext = {
      resuming: true,
      resumeId: input.sessionId,
      taskText: input.task,
      sessionsDir: opts.sessionsDir,
      checkpointsDir: opts.checkpointsDir,
      permissionsDir: opts.permissionsDir,
      configDir: opts.configDir,
      cwd: input.cwd,
      database: opts.database,
    };
    const prepared = await prepareSession(ctx, opts.deps, false, false);
    if (typeof prepared === "number") return { exitCode: 1 };

    try {
      const approvalPrompt: ApprovalPrompt | undefined =
        input.promptChannel === "none"
          ? undefined
          : async (toolName, args, signal) => {
              if (signal?.aborted) return "no";
              const requestId = randomUUID();
              const pending = input.requestApproval(requestId, toolName, args);
              if (signal === undefined) return pending;
              return await new Promise((resolve, reject) => {
                const onAbort = () => resolve("no");
                signal.addEventListener("abort", onAbort, { once: true });
                pending.then(
                  (answer) => {
                    signal.removeEventListener("abort", onAbort);
                    resolve(answer);
                  },
                  (error) => {
                    signal.removeEventListener("abort", onAbort);
                    reject(error);
                  },
                );
              });
            };

      const archivistState = createArchivistState(
        prepared.session,
        opts.database.getArchivistCursor(input.sessionId),
      );
      const result = await driveLoop(
        prepared,
        ctx,
        opts.deps,
        undefined,
        (event) => input.emitLoop(event),
        () => input.permissionMode,
        (session) => saveSession(session, ctx.sessionsDir, opts.database),
        approvalPrompt,
        archivistState,
        undefined,
        {
          signal: input.signal,
          bindProcessCancel: false,
          composeSubagents: true,
        },
      );
      opts.database.setArchivistCursor(input.sessionId, archivistState.messageCursor);
      return { exitCode: exitCodeFromDriveResult(result) };
    } finally {
      // prepareSession mints a new pool every call. The TUI keeps one for the process and
      // closes it in bindSession (/clear). This path is one turn, then PreparedRun is dropped,
      // so the pool has to close here or each dialled server leaks until seri serve exits.
      closeMcpClients(prepared.mcpClients, (message) => printWarning(message));
    }
  };
}
