import { randomUUID } from "node:crypto";
import type { ApprovalPrompt } from "../loop/loop";
import { createArchivistState } from "../memory/archivist";
import { driveLoop, exitCodeFromDriveResult } from "../runtime/drive";
import { prepareSession } from "../runtime/prepare";
import { saveSession } from "../session/session";
import type { CliDeps, RunContext } from "../cli";
import type { ExecuteTurn } from "./sessionManager";

export function createAttendedExecuteTurn(opts: {
  configDir: string;
  sessionsDir: string;
  checkpointsDir: string;
  permissionsDir: string;
  deps: CliDeps;
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
      effortFlag: undefined,
      detailFlag: false,
      cwd: input.cwd,
    };
    const prepared = await prepareSession(ctx, opts.deps, false, false);
    if (typeof prepared === "number") return { exitCode: 1 };

    const approvalPrompt: ApprovalPrompt = async (toolName, args, signal) => {
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

    const result = await driveLoop(
      prepared,
      ctx,
      opts.deps,
      undefined,
      (event) => input.emitLoop(event),
      () => input.permissionMode,
      (session) => saveSession(session, ctx.sessionsDir),
      approvalPrompt,
      createArchivistState(prepared.session),
      undefined,
      {
        signal: input.signal,
        bindProcessCancel: false,
        composeSubagents: true,
      },
    );
    return { exitCode: exitCodeFromDriveResult(result) };
  };
}
