import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  type UndoPlan,
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

// Commands that operate on the resume target rather than being a task for the model. One table,
// so a new one is added in exactly one place: `parseTaskArgs` derives the names it must not
// mistake for a session id from these keys, and the dispatch in `run()` shares the resume-target
// resolution and the error reporting. Handlers throw to report a bad invocation; the caller turns
// that into a message and a non-zero exit.
//
// A Map rather than an object literal, because an object literal inherits Object.prototype and a
// lookup keyed on user input walks it: `SLASH_COMMANDS["toString"]` returned a function, so
// `seri "toString is wrong on User, fix it"` dispatched Object.prototype.toString against the most
// recent session, printed nothing and exited 0 — the task never reached the model. `constructor`,
// `valueOf`, `hasOwnProperty` and `isPrototypeOf` did the same, and `__proto__` resolved to an
// object and crashed with "command is not a function". A Map has no prototype chain to walk, so
// the hazard is gone from every call site rather than from the ones that remember Object.hasOwn.
const SLASH_COMMANDS = new Map<string, (session: SessionState<ModelMessage>, args: string[], dirs: CommandDirs) => void>([
  ["/mode", cycleModeCommand],
  ["/undo", undoCommand],
  ["/rewind", rewindCommand],
]);

type CommandDirs = { sessionsDir: string; checkpointsDir: string };

function parseTaskArgs(argv: string[]): { resuming: boolean; resumeId: string | undefined; taskText: string } {
  const args = [...argv];
  const resumeIndex = args.indexOf("--resume");
  if (resumeIndex === -1) return { resuming: false, resumeId: undefined, taskText: args.join(" ").trim() };

  args.splice(resumeIndex, 1);
  const next = args[resumeIndex];
  // A slash command is never a session id, even though none of them starts with "-": it has to
  // fall through to the taskText below instead of being looked up and throwing "session not found".
  const resumeId = next !== undefined && !SLASH_COMMANDS.has(next) && !next.startsWith("-") ? next : undefined;
  if (resumeId !== undefined) args.splice(resumeIndex, 1);

  return { resuming: true, resumeId, taskText: args.join(" ").trim() };
}

function parseSteps(name: string, args: string[]): number {
  const steps = args[0] === undefined ? 1 : Number(args[0]);
  if (args.length > 1 || !Number.isInteger(steps) || steps < 1) {
    throw new Error(`${name} takes at most one argument, a positive number of steps.`);
  }
  return steps;
}

function cycleModeCommand(session: SessionState<ModelMessage>, args: string[], dirs: CommandDirs): void {
  if (args.length > 0) throw new Error("/mode takes no arguments.");
  session.permissionMode = cycleMode(session.permissionMode);
  saveSession(session, dirs.sessionsDir);
  console.log(`Session ${session.id}: permission mode is now ${session.permissionMode}`);
}

function undoCommand(session: SessionState<ModelMessage>, args: string[], dirs: CommandDirs): void {
  const result = undoFiles({
    storeDir: checkpointStoreDir(dirs.checkpointsDir, session.cwd),
    worktree: session.cwd,
    sessionId: session.id,
    steps: parseSteps("/undo", args),
    onPlan: printUndoPlan,
  });
  console.log(`Undid to checkpoint ${result.seq}.`);
  // Undo is never the operation that loses work: the state it just replaced was committed first.
  console.log(`The state this replaced is commit ${result.preUndoCommit}. To get it back:`);
  console.log(`  ${result.recoverCommand}`);
}

function rewindCommand(session: SessionState<ModelMessage>, args: string[], dirs: CommandDirs): void {
  const { rewindTo } = rewindConversation({
    storeDir: checkpointStoreDir(dirs.checkpointsDir, session.cwd),
    sessionId: session.id,
    steps: parseSteps("/rewind", args),
  });
  // Clamped, because an anchor can outlive the array it indexed: a previous /rewind truncated the
  // session and the messages that followed reused those indices. Slicing past the end is a silent
  // no-op, and reporting the anchor rather than the count would announce a truncation that never
  // happened.
  const kept = Math.min(rewindTo, session.messages.length);
  const dropped = session.messages.length - kept;
  session.messages = session.messages.slice(0, kept);
  saveSession(session, dirs.sessionsDir);
  console.log(`Session ${session.id}: dropped ${dropped} message(s), ${kept} remain. No file was touched.`);
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

// Printed before the restore happens, not after. Every path here comes from git's own output, so
// an ignored file can never appear under "restored" or "deleted"; the ones that were written and
// skipped are listed separately rather than left for the user to notice was missing. The deletion
// list matters most: the removal pass takes every untracked, non-ignored file, including ones a
// human made by hand in another terminal.
function printUndoPlan(plan: UndoPlan): void {
  if (plan.diff) console.log(plan.diff);
  for (const path of plan.restored) console.log(`restored ${path}`);
  for (const path of plan.deleted) console.log(`deleted  ${path}`);
  if (plan.ignored.length > 0) console.log(`not restored (gitignored): ${plan.ignored.join(", ")}`);
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

  // A slash command always operates on the resume target — an explicit --resume id, or the most
  // recent session — and never creates a session just to act on it, so this is checked before
  // loadOrCreateSession and a bare `/undo` (no --resume) does not fall into the new-session path
  // below. `/undo` and `/rewind` are keyed on the session's own `cwd`, not the current one, so
  // running them from a different directory still finds the store the edits were recorded in.
  const [name = "", ...commandArgs] = taskText.split(/\s+/).filter(Boolean);
  const command = SLASH_COMMANDS.get(name);
  if (command !== undefined) {
    const id = resumeId ?? findMostRecentSession(sessionsDir);
    if (!id) {
      console.error(`No session to run ${name} against.`);
      return 1;
    }
    try {
      command(loadSession<ModelMessage>(id, sessionsDir), commandArgs, { sessionsDir, checkpointsDir });
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
    // instead of silently slicing garbage. A session that never checkpointed has no log, and
    // appendBarrier no-ops rather than making this caller guess at that.
    if (event.type === "compacted") appendBarrier(storeDir, session.id);
    printEvent(event);
  }

  return 0;
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
