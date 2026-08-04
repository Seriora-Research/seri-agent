import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ModelMessage } from "ai";
import pkg from "../package.json";
import { loadAgentsFile as loadAgentsFileReal } from "./agents/loadAgentsFile";
import { login as loginReal, logout as logoutReal } from "./auth/commands";
import { getWorkosClientId } from "./auth/deviceFlow";
import {
  appendBarrier,
  checkpointStoreDir,
  createCheckpointer,
  rewindConversation,
  undoFiles,
} from "./checkpoint/checkpoint";
import { withCheckpoints } from "./checkpoint/wrapTools";
import { configCommand as configCommandReal } from "./config/commands";
import { getConfigDir } from "./config/paths";
import { cycleMode } from "./gate/gate";
import { type ApprovalPrompt, type LoopEvent, runLoop as runLoopReal } from "./loop/loop";
import { getGroqModel as getGroqModelReal } from "./provider/groq";
import { toolDefinitions } from "./provider/tools";
import { findMostRecentSession, loadSession, saveSession, type SessionState } from "./session/session";
import { grep as grepReal } from "./tools/grep";
import { resolveRg, rgVersion } from "./tools/runRipgrep";

type CliDeps = {
  runLoop?: typeof runLoopReal;
  getGroqModel?: typeof getGroqModelReal;
  loadAgentsFile?: typeof loadAgentsFileReal;
  sessionsDir?: string;
  checkpointsDir?: string;
  authConfigDir?: string;
  login?: typeof loginReal;
  logout?: typeof logoutReal;
  configCommand?: typeof configCommandReal;
  grep?: typeof grepReal;
};

// None of these is ever a session id, even though none starts with "-": each is a command that
// operates on the resume target, so it must fall through to the taskText below and be
// special-cased by `run()` instead of being looked up and throwing "session not found".
const SLASH_COMMANDS = new Set(["/mode", "/undo", "/rewind"]);

function parseTaskArgs(argv: string[]): { resuming: boolean; resumeId: string | undefined; taskText: string } {
  const args = [...argv];
  const resumeIndex = args.indexOf("--resume");
  if (resumeIndex === -1) return { resuming: false, resumeId: undefined, taskText: args.join(" ").trim() };

  args.splice(resumeIndex, 1);
  const next = args[resumeIndex];
  const resumeId = next !== undefined && !SLASH_COMMANDS.has(next) && !next.startsWith("-") ? next : undefined;
  if (resumeId !== undefined) args.splice(resumeIndex, 1);

  return { resuming: true, resumeId, taskText: args.join(" ").trim() };
}

function loadOrCreateSession(
  resuming: boolean,
  resumeId: string | undefined,
  sessionsDir: string,
  loadAgentsFileFn: typeof loadAgentsFileReal,
): SessionState<ModelMessage> {
  if (resuming) {
    const id = resumeId ?? findMostRecentSession(sessionsDir);
    if (!id) throw new Error("No session to resume.");
    return loadSession<ModelMessage>(id, sessionsDir);
  }

  const agentsContent = loadAgentsFileFn(process.cwd());
  const systemPrompt = agentsContent ? `You are seri, a coding agent.\n\n${agentsContent}` : "You are seri, a coding agent.";
  return {
    id: randomUUID(),
    cwd: process.cwd(),
    systemPrompt,
    // Read-only is the safest default for a brand-new session: nothing in build-plan.md/
    // definitive-harness.md states an explicit default, so this errs on the side of never
    // writing/executing without the user opting in via --resume onto an existing session
    // or cycling the mode themselves.
    permissionMode: "read-only",
    messages: [],
  };
}

// One readline prompt per approval, opened and closed on demand, so a task that never
// needs approval (read-only/auto modes) never touches stdin at all.
function makeApprovalPrompt(): ApprovalPrompt {
  return (toolName, args) =>
    new Promise<boolean>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`Approve ${toolName}(${JSON.stringify(args)})? [y/N] `, (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === "y");
      });
    });
}

// stderr, not stdout: stdout carries the model's own output and is routinely piped, and a warning
// that a file will not be recoverable must not end up inside whatever consumed that pipe.
function printWarning(message: string): void {
  console.error(`⚠ ${message}`);
}

// Every path here comes from git's own output, so an ignored file can never appear under
// "restored" or "deleted". The ones that were written and skipped are listed separately rather
// than left for the user to notice was missing.
function printUndo(result: ReturnType<typeof undoFiles>, storeDir: string, worktree: string): void {
  if (result.diff) console.log(result.diff);
  for (const path of result.restored) console.log(`restored ${path}`);
  for (const path of result.deleted) console.log(`deleted  ${path}`);
  if (result.ignored.length > 0) console.log(`not restored (gitignored): ${result.ignored.join(", ")}`);
  console.log(`Undid to checkpoint ${result.seq}.`);

  // Undo is never the operation that loses work: the state it just replaced was committed first,
  // and the command that brings it back is plain git, not a seri subcommand.
  const gitDir = join(storeDir, "git");
  console.log(`The state this replaced is commit ${result.preUndoCommit}. To get it back:`);
  console.log(
    `  git --git-dir=${gitDir} --work-tree=${worktree} read-tree ${result.preUndoCommit} && ` +
      `git --git-dir=${gitDir} --work-tree=${worktree} checkout-index -a -f`,
  );
}

function printEvent(event: LoopEvent): void {
  switch (event.type) {
    case "text-delta":
      process.stdout.write(event.text);
      break;
    case "tool-call":
      console.log(`\n→ ${event.name}(${JSON.stringify(event.args)})`);
      break;
    case "tool-result":
      console.log(`✓ ${event.name} done`);
      break;
    case "permission-denied":
      console.log(`✗ ${event.name} blocked`);
      break;
    case "compacted":
      console.log(`\n⚙ compacted ${event.evictedCount} messages`);
      break;
    case "done":
      console.log(`\n(done: ${event.reason})`);
      break;
    case "error":
      console.error(event.error);
      break;
  }
}

export async function run(argv: string[], deps: CliDeps = {}): Promise<number> {
  if (argv.length === 0 || argv.includes("--version") || argv.includes("-v")) {
    if (argv.includes("--version") || argv.includes("-v")) console.log(`seri ${pkg.version}`);
    return 0;
  }

  // Undocumented build-verification flag: the embedded ripgrep is vendored for the build
  // host, so a cross-compiled binary can ship one that cannot run on the target. Spawning
  // it for real is the only way to catch that from a shipped artifact; the release workflow
  // runs this on every platform. Greps a throwaway file rather than the cwd so the result
  // never depends on what happens to be in the directory seri was launched from.
  if (argv.includes("--selftest")) {
    const grepFn = deps.grep ?? grepReal;
    try {
      const dir = mkdtempSync(join(tmpdir(), "seri-selftest-"));
      try {
        writeFileSync(join(dir, "probe.txt"), "seri selftest probe\n");
        const { matches = [] } = grepFn("selftest probe", { path: dir, mode: "content" });
        if (matches.length !== 1) throw new Error(`ripgrep returned ${matches.length} matches, expected 1`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      // Names the version, because "it worked" leaves the one thing a cross-compiled artifact can
      // get wrong — which rg was actually vendored for this target — unsaid.
      console.log(`selftest ok: ripgrep ${rgVersion(resolveRg())}`);
      return 0;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  if (argv[0] === "login" || argv[0] === "signup") {
    const loginFn = deps.login ?? loginReal;
    try {
      const configDir = deps.authConfigDir ?? getConfigDir();
      await loginFn(argv[0], getWorkosClientId(configDir), configDir);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
    return 0;
  }
  if (argv[0] === "logout") {
    const logoutFn = deps.logout ?? logoutReal;
    try {
      logoutFn(deps.authConfigDir ?? getConfigDir());
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
    return 0;
  }

  if (argv[0] === "config") {
    const configCommandFn = deps.configCommand ?? configCommandReal;
    try {
      return configCommandFn(argv.slice(1), deps.authConfigDir ?? getConfigDir());
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  const { resuming, resumeId, taskText } = parseTaskArgs(argv);
  const sessionsDir = deps.sessionsDir ?? join(getConfigDir(), "sessions");
  const checkpointsDir = deps.checkpointsDir ?? join(getConfigDir(), "checkpoints");
  const loadAgentsFileFn = deps.loadAgentsFile ?? loadAgentsFileReal;

  // `/mode` is a mode-cycle command, not a task for the model. It always operates on the
  // resume target (an explicit --resume id, or the most-recent session) and never creates
  // a new session just to cycle it — checked before loadOrCreateSession so a bare `/mode`
  // (no --resume) doesn't fall into the new-session path below.
  if (taskText === "/mode") {
    const id = resumeId ?? findMostRecentSession(sessionsDir);
    if (!id) {
      console.error("No session to cycle the mode of.");
      return 1;
    }
    const session = loadSession(id, sessionsDir);
    session.permissionMode = cycleMode(session.permissionMode);
    saveSession(session, sessionsDir);
    console.log(`Session ${session.id}: permission mode is now ${session.permissionMode}`);
    return 0;
  }

  // `/undo` (files) and `/rewind` (conversation) read the same log, so running both — in either
  // order — rewinds both axes and there is no third command and no flag. Like `/mode` they are
  // argv rather than REPL commands, and they always operate on the resume target. Both are keyed
  // on the session's own `cwd`, not the current one, so undoing from a different directory still
  // finds the store the edits were recorded in.
  const [checkpointCommand, stepsArg] = taskText.split(/\s+/);
  if (checkpointCommand === "/undo" || checkpointCommand === "/rewind") {
    const steps = stepsArg === undefined ? 1 : Number(stepsArg);
    if (!Number.isInteger(steps) || steps < 1) {
      console.error(`${checkpointCommand} takes a positive number of steps; got "${stepsArg}".`);
      return 1;
    }
    const id = resumeId ?? findMostRecentSession(sessionsDir);
    if (!id) {
      console.error(`No session to run ${checkpointCommand} against.`);
      return 1;
    }
    try {
      const target = loadSession<ModelMessage>(id, sessionsDir);
      const storeDir = checkpointStoreDir(checkpointsDir, target.cwd);
      if (checkpointCommand === "/rewind") {
        const { rewindTo } = rewindConversation({ storeDir, sessionId: target.id, steps });
        target.messages = target.messages.slice(0, rewindTo);
        saveSession(target, sessionsDir);
        console.log(`Session ${target.id}: rewound to ${rewindTo} message(s). No file was touched.`);
        return 0;
      }
      printUndo(undoFiles({ storeDir, worktree: target.cwd, sessionId: target.id, steps }), storeDir, target.cwd);
      return 0;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  let session: SessionState<ModelMessage>;
  try {
    session = loadOrCreateSession(resuming, resumeId, sessionsDir, loadAgentsFileFn);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (!resuming) console.log(`Session ${session.id} created.`);

  if (!resuming || taskText) {
    session.messages.push({ role: "user", content: taskText });
  }

  const getGroqModelFn = deps.getGroqModel ?? getGroqModelReal;
  let model;
  try {
    model = getGroqModelFn();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  saveSession(session, sessionsDir);

  // Checkpointing is enabled by exactly this call, which is also why rolling it back is a one-line
  // revert: `runLoop`, the session store, the gate and every tool are unmodified, and the store
  // lives entirely outside the user's repository.
  const storeDir = checkpointStoreDir(checkpointsDir, session.cwd);
  const tools = withCheckpoints(
    toolDefinitions,
    createCheckpointer({ storeDir, worktree: session.cwd, sessionId: session.id, onWarning: printWarning }),
  );

  const runLoopFn = deps.runLoop ?? runLoopReal;
  for await (const event of runLoopFn({
    model,
    tools,
    messages: session.messages,
    permissionMode: session.permissionMode,
    approvalPrompt: makeApprovalPrompt(),
    system: session.systemPrompt,
  })) {
    if (event.type === "messages-updated") {
      saveSession({ ...session, messages: event.messages }, sessionsDir);
      continue;
    }
    // Compaction splices the whole message array, so every rewind anchor recorded before this
    // point indexes into an array that no longer exists. The barrier is what lets `/rewind` say so
    // instead of silently slicing garbage. Only written if a checkpoint actually started — with
    // git absent there is no store to append to.
    if (event.type === "compacted" && existsSync(storeDir)) appendBarrier(storeDir, session.id);
    printEvent(event);
  }

  return 0;
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
