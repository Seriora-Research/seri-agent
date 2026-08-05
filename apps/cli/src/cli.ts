import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { ModelMessage } from "ai";
import pkg from "../package.json";
import { loadAgentsFile as loadAgentsFileReal } from "./agents/loadAgentsFile";
import { login as loginReal, logout as logoutReal } from "./auth/commands";
import { getWorkosClientId } from "./auth/deviceFlow";
import {
  appendBarrier,
  checkpointStoreDir,
  createCheckpointer,
  restoreCommit,
  type RestorePlan,
  type RestoreResult,
  rewindConversation,
  undoFiles,
} from "./checkpoint/checkpoint";
import { projectRoot } from "./checkpoint/shadowGit";
import { withCheckpoints } from "./checkpoint/wrapTools";
import { configCommand as configCommandReal } from "./config/commands";
import { getConfigDir } from "./config/paths";
import { cycleMode } from "./gate/gate";
import { type ApprovalPrompt, type LoopEvent, runLoop as runLoopReal } from "./loop/loop";
import { getGroqModel as getGroqModelReal } from "./provider/groq";
import { toolDefinitions } from "./provider/tools";
import { findMostRecentSession, loadSession, saveSession, type SessionState } from "./session/session";
import { deliverSignal, onSignalCancel, raiseSignal } from "./signals";
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
  createInterface?: () => Interface;
};

type CommandDirs = { sessionsDir: string; checkpointsDir: string };

type SlashCommand = {
  // Whether these arguments are an invocation of this command at all — checked BEFORE the dispatch
  // claims the input, because the first word of a task is not a command. The dispatch splits the
  // task on whitespace and looks up token one, so `seri "/undo the rename and try again"` was
  // hijacked and died in the step parser with the task never sent, and `seri "/mode is broken, fix
  // it"` — an ordinary task before the table existed — went the same way. The command forms are
  // exact and small, so anything outside them falls through to the model, which is the only
  // direction that cannot silently swallow work.
  accepts: (args: string[]) => boolean;
  run: (session: SessionState<ModelMessage>, args: string[], dirs: CommandDirs) => void;
};

// A step count, or nothing at all.
function isStepCount(args: string[]): boolean {
  return args.length === 0 || (args.length === 1 && /^[1-9]\d*$/.test(args[0] ?? ""));
}

function steps(args: string[]): number {
  return args[0] === undefined ? 1 : Number(args[0]);
}

// Commands that operate on the resume target rather than being a task for the model. One table,
// so a new one is added in exactly one place: `parseTaskArgs` derives the names it must not
// mistake for a session id from these keys, and the dispatch in `run()` shares the resume-target
// resolution and the error reporting. Handlers throw to report a failure; the caller turns that
// into a message and a non-zero exit.
//
// A Map rather than an object literal, because an object literal inherits Object.prototype and a
// lookup keyed on user input walks it: `SLASH_COMMANDS["toString"]` returned a function, so
// `seri "toString is wrong on User, fix it"` dispatched Object.prototype.toString against the most
// recent session, printed nothing and exited 0 — the task never reached the model. `constructor`,
// `valueOf`, `hasOwnProperty` and `isPrototypeOf` did the same, and `__proto__` resolved to an
// object and crashed with "command is not a function". A Map has no prototype chain to walk, so
// the hazard is gone from every call site rather than from the ones that remember Object.hasOwn.
const SLASH_COMMANDS = new Map<string, SlashCommand>([
  ["/mode", { accepts: (args) => args.length === 0, run: cycleModeCommand }],
  ["/undo", { accepts: isStepCount, run: undoCommand }],
  // A sha and nothing else. `seri "/restore the header spacing"` is a task.
  ["/restore", { accepts: (args) => args.length === 1 && /^[0-9a-f]{4,40}$/.test(args[0] ?? ""), run: restoreCommand }],
  ["/rewind", { accepts: isStepCount, run: rewindCommand }],
]);

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

function cycleModeCommand(session: SessionState<ModelMessage>, _args: string[], dirs: CommandDirs): void {
  session.permissionMode = cycleMode(session.permissionMode);
  saveSession(session, dirs.sessionsDir);
  console.log(`Session ${session.id}: permission mode is now ${session.permissionMode}`);
}

// The tree a session's checkpoints are of, and the store they live in. The session records the
// directory seri was started in, which is not necessarily the project — resolving the root here
// rather than at each call site is what keeps the live run and the three restoring commands
// addressing the same store, since the key is derived from it.
function checkpointTarget(session: SessionState<ModelMessage>, dirs: CommandDirs): {
  storeDir: string;
  worktree: string;
} {
  const worktree = projectRoot(session.cwd);
  return { storeDir: checkpointStoreDir(dirs.checkpointsDir, worktree), worktree };
}

function undoCommand(session: SessionState<ModelMessage>, args: string[], dirs: CommandDirs): void {
  const result = undoFiles({
    ...checkpointTarget(session, dirs),
    sessionId: session.id,
    steps: steps(args),
    onPlan: printUndoPlan,
  });
  // The step the user asked for, not the record's `seq`. `seq` is the 0-based index of a tool
  // record while `/undo n` is 1-based over DISTINCT trees, so the two only ever agreed by
  // accident: the first checkpoint printed "checkpoint 0", and over records [T0, T1, T1, T2]
  // `/undo 2` printed "checkpoint 2" while restoring the state that preceded tool call 1. A
  // number a user is shown has to be one they can hand back to the command that showed it.
  //
  // A step count is absolute — the n-th most recent distinct checkpoint — not relative to wherever
  // a previous undo left the worktree, so `/undo 1` run three times aims at the same checkpoint
  // three times. Measured before this: each of the three printed that it had undone and minted a
  // fresh recovery commit while the file stayed exactly where the first one put it. Saying so is
  // the same honesty `/rewind`'s "dropped 0 message(s)" already applies.
  if (result.restored.length === 0 && result.deleted.length === 0) {
    console.log(`Already at checkpoint ${steps(args)}; no file changed.`);
    return;
  }
  console.log(`Undid to checkpoint ${steps(args)}.`);
  printRecovery(result);
}

// The other end of what /undo and /restore print: put the worktree back to a commit this session
// recorded. It exists so recovery is a command that reuses the restore path — removal pass
// included — rather than a git incantation the user pastes and hopes about.
function restoreCommand(session: SessionState<ModelMessage>, args: string[], dirs: CommandDirs): void {
  const commit = args[0] ?? "";
  const result = restoreCommit({
    ...checkpointTarget(session, dirs),
    sessionId: session.id,
    commit,
    onPlan: printUndoPlan,
  });
  if (result.restored.length === 0 && result.deleted.length === 0) {
    console.log(`Already at ${commit}; no file changed.`);
    return;
  }
  console.log(`Restored ${commit}.`);
  printRecovery(result);
}

// Restoring is never the operation that loses work: the state it just replaced was committed first.
function printRecovery(result: RestoreResult): void {
  console.log(`The state this replaced is commit ${result.preUndoCommit}. To get it back:`);
  console.log(`  ${result.recoverCommand}`);
}

function rewindCommand(session: SessionState<ModelMessage>, args: string[], dirs: CommandDirs): void {
  const { storeDir } = checkpointTarget(session, dirs);
  const { rewindTo } = rewindConversation({ storeDir, sessionId: session.id, steps: steps(args) });
  // Clamped, because an anchor can outlive the array it indexed: a previous /rewind truncated the
  // session and the messages that followed reused those indices. Slicing past the end is a silent
  // no-op, and reporting the anchor rather than the count would announce a truncation that never
  // happened.
  const kept = Math.min(rewindTo, session.messages.length);
  const dropped = session.messages.length - kept;
  session.messages = session.messages.slice(0, kept);
  saveSession(session, dirs.sessionsDir);
  // Clamping only catches the anchors that are too LARGE, and those are the harmless ones. An
  // older anchor small enough to index the rebuilt array points at a DIFFERENT message: with
  // anchors [1,3,5,7] over nine messages, `/rewind 2` truncates to five, a resume appends five
  // more and records [6,8], and `/rewind 3` then reaches the stale 7 and slices to 7 — leaving an
  // assistant tool-call whose tool result was dropped, which is AI_MissingToolResultsError on the
  // next resume and the exact failure `rewindTo = messages.length - 1` exists to prevent. So a
  // rewind draws the same kind of line compaction does. Recorded only when something was actually
  // dropped: a no-op rewind invalidates nothing, and a barrier for it would throw away history
  // that is still good.
  if (dropped > 0) appendBarrier(storeDir, session.id, "rewind");
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
//
// Two wires into the same cancel, because a Ctrl-C at this prompt is not delivered the way a
// Ctrl-C during streaming is. Measured on a real pty, all three candidate handlers registered while
// rl.question was up, one real 0x03 sent: rl's SIGINT fired, rl's close fired, and
// process.on("SIGINT") NEVER fired. Readline in terminal mode puts stdin in raw mode, so the tty
// stops generating the signal for the process and hands the byte over as data; readline emits the
// event on the INTERFACE instead. With nothing listening there, readline closes itself, the
// question's callback never runs, the event loop empties and the process is simply gone — with the
// turn's tool calls persisted and no tool-result row, i.e. AI_MissingToolResultsError on the next
// --resume. Reproduced end to end on the compiled binary before this listener existed.
//
// So rl's SIGINT is routed into deliverSignal — signals.ts's own entry point, the one its
// process-level listener uses — rather than into a second copy of the cancel rules that would
// drift from it. The first press spends the single cancel slot and cli.ts unwinds the turn; a
// second press finds the slot empty and takes the fatal path, exactly as it would mid-stream.
//
// The abort listener is the other direction: a cancel that originated elsewhere while the prompt is
// up. Closing the interface and resolving false is what unparks the turn. The loop tells that false
// apart from a typed "n" by re-checking the signal, so the row the model sees says the call was
// cancelled rather than denied. An already-aborted signal emits no abort event, so it is answered
// up front rather than by a listener that would wait for something already past.
function makeApprovalPrompt(
  openInterface: () => Interface = () => createInterface({ input: process.stdin, output: process.stdout }),
): ApprovalPrompt {
  return (toolName, args, signal) =>
    new Promise<boolean>((resolve) => {
      if (signal?.aborted === true) {
        resolve(false);
        return;
      }
      const rl = openInterface();
      const onAbort = (): void => {
        rl.close();
        resolve(false);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      rl.on("SIGINT", () => deliverSignal("SIGINT"));
      rl.question(`Approve ${toolName}(${JSON.stringify(args)})? [y/N] `, (answer) => {
        signal?.removeEventListener("abort", onAbort);
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
function printUndoPlan(plan: RestorePlan): void {
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
        const { matches = [] } = await grepFn("selftest probe", { path: dir, mode: "content" });
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
  if (command !== undefined && command.accepts(commandArgs)) {
    const id = resumeId ?? findMostRecentSession(sessionsDir);
    if (!id) {
      console.error(`No session to run ${name} against.`);
      return 1;
    }
    try {
      command.run(loadSession<ModelMessage>(id, sessionsDir), commandArgs, { sessionsDir, checkpointsDir });
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
  const { storeDir, worktree } = checkpointTarget(session, { sessionsDir, checkpointsDir });

  // `write_file`, `bash` and `powershell` write relative to process.cwd(), while the snapshot
  // covers the project root. Anywhere inside the project is fine — that is the whole point of
  // resolving the root, and it is why a subdirectory launch no longer trips this. What is left is
  // a genuine cross-project resume: it would snapshot one project while the tools edit another,
  // and a later /undo would run its removal pass in the ORIGINAL project, deleting untracked files
  // a human made there. Said out loud rather than left to be discovered by the deletion.
  const inProject = relative(worktree, process.cwd());
  if (inProject === ".." || inProject.startsWith(`..${sep}`) || isAbsolute(inProject)) {
    printWarning(
      `this session's files are checkpointed under ${worktree}, but tools run in ${process.cwd()} — /undo will act on ${worktree}`,
    );
  }

  const tools = withCheckpoints(
    toolDefinitions,
    createCheckpointer({ storeDir, worktree, sessionId: session.id, onWarning: printWarning }),
  );

  const runLoopFn = deps.runLoop ?? runLoopReal;

  // The controller lives here, not in the loop: runLoop is a library that is handed a signal, and
  // the consumer is the only thing that knows what a Ctrl-C means. The first press lands in
  // signals.ts's cancel slot, aborts the turn, and the loop unwinds far enough to yield a final
  // messages-updated — which the body below persists, so the session left behind is resumable. The
  // second press finds the slot empty and takes the file's untouched fatal path.
  const controller = new AbortController();
  let cancelledBy: NodeJS.Signals | undefined;
  const unregisterCancel = onSignalCancel((signal) => {
    cancelledBy = signal;
    controller.abort();
  });

  try {
    for await (const event of runLoopFn({
      model,
      tools,
      messages: session.messages,
      permissionMode: session.permissionMode,
      approvalPrompt: makeApprovalPrompt(deps.createInterface),
      system: session.systemPrompt,
      signal: controller.signal,
    })) {
      if (event.type === "messages-updated") {
        saveSession({ ...session, messages: event.messages }, sessionsDir);
        continue;
      }
      // Compaction splices the whole message array, so every rewind anchor recorded before this
      // point indexes into an array that no longer exists. The barrier is what lets `/rewind` say
      // so instead of silently slicing garbage. A session that never checkpointed has no log, and
      // appendBarrier no-ops rather than making this caller guess at that.
      //
      // Wrapped, because this is the only checkpoint call on the run path that was outside the
      // degrade-never-fail policy every other one obeys: the checkpointer catches and latches, and
      // the slash commands sit inside the dispatch's try. An appendFileSync that fails here —
      // ENOSPC, EACCES, the store removed mid-session — threw straight out of this loop and killed
      // the user's in-flight session, which is a checkpointing failure taking down the thing
      // checkpointing exists to protect. The cost of losing a barrier is that a later /rewind may
      // cross this compaction, so it is a warning and not silence.
      if (event.type === "compacted") {
        try {
          appendBarrier(storeDir, session.id, "compaction");
        } catch (err) {
          printWarning(
            `could not record the compaction barrier, so /rewind may not be able to cross this point: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      printEvent(event);
    }
  } finally {
    // In a finally, so a run that throws out of the loop does not leave the slot pointing at a
    // controller nothing is waiting on — a later signal would then be swallowed as a cancel of a
    // turn that is no longer running instead of killing the process.
    unregisterCancel();
  }

  // The turn was cancelled, so the process still dies the way Ctrl-C makes a process die. Not
  // process.exit: a status is not a death by signal, and `for f in a b c; do seri "$f"; done` only
  // breaks out of the loop when the child was killed BY SIGINT — exiting 0 here would turn one
  // Ctrl-C into one press per iteration, the exact regression signals.ts's re-raise exists to
  // prevent. raiseSignal is that same re-raise, shared rather than re-implemented, and it does not
  // return, so the 0 below is for every other way this function ends.
  if (cancelledBy !== undefined) raiseSignal(cancelledBy);

  return 0;
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
