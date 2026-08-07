import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { parseArgs } from "node:util";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import pkg from "../package.json";
import { onAbort } from "./abort";
import { loadAgentsFile as loadAgentsFileReal } from "./agents/loadAgentsFile";
import { buildSystemPrompt } from "./agents/systemPrompt";
import { login as loginReal, logout as logoutReal } from "./auth/commands";
import { getWorkosClientId } from "./auth/deviceFlow";
import {
  appendBarrier,
  checkpointStoreDir,
  createCheckpointer,
  restoreCommit,
  rewindConversation,
  undoFiles,
} from "./checkpoint/checkpoint";
import { projectRoot } from "./checkpoint/shadowGit";
import { withCheckpoints } from "./checkpoint/wrapTools";
import {
  escapeControlChars,
  printEvent,
  printRecovery,
  printUndoPlan,
  printUsage,
  printWarning,
  type RunUsage,
  USAGE,
  usageError,
} from "./cli/output";
import { configCommand as configCommandReal } from "./config/commands";
import { loadVerifyConfig } from "./config/config";
import { getConfigDir } from "./config/paths";
import { cycleMode, type PermissionMode } from "./gate/gate";
import { type ApprovalAnswer, type ApprovalPrompt, type LoopEvent, runLoop as runLoopReal } from "./loop/loop";
import { getGroqModel as getGroqModelReal, resolveModelId } from "./provider/groq";
import { toolDefinitions } from "./provider/tools";
import { findMostRecentSession, loadSession, saveSession, type SessionState } from "./session/session";
import { deliverSignal, onSignalCancel, raiseSignal } from "./signals";
import { grep as grepReal } from "./tools/grep";
import { resolveRg, rgVersion } from "./tools/runRipgrep";
import { withVerification } from "./verify/wrapTools";

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
// so a new one is added in exactly one place: the dispatch in `run()` shares the resume-target
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
export const SLASH_COMMANDS = new Map<string, SlashCommand>([
  ["/mode", { accepts: (args) => args.length === 0, run: cycleModeCommand }],
  ["/undo", { accepts: isStepCount, run: undoCommand }],
  // A sha and nothing else. `seri "/restore the header spacing"` is a task.
  ["/restore", { accepts: (args) => args.length === 1 && /^[0-9a-f]{4,40}$/.test(args[0] ?? ""), run: restoreCommand }],
  ["/rewind", { accepts: isStepCount, run: rewindCommand }],
]);

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

// `model` is optional on SessionState so that sessions written before the field existed still load,
// but every session this function hands back has one — which is what lets the rest of the run stop
// asking, and getGroqModel drop its default parameter.
type RunSession = SessionState<ModelMessage> & { model: string };

// `modelRecorded` says where the model came from: true if the session file already had one, false
// if it was just resolved from the environment and no provider call has confirmed it exists.
// prepareSession uses it to decide whether the creation-time save may persist it — see there.
function loadOrCreateSession(
  resuming: boolean,
  resumeId: string | undefined,
  sessionsDir: string,
  loadAgentsFileFn: typeof loadAgentsFileReal,
): { session: RunSession; modelRecorded: boolean } {
  if (resuming) {
    const id = resumeId ?? findMostRecentSession(sessionsDir);
    if (!id) throw new Error("No session to resume.");
    const loaded = loadSession<ModelMessage>(id, sessionsDir);
    // The two stored fields are treated differently on purpose.
    //
    // `systemPrompt` is rebuilt every time, never replayed: it is a product of this binary's
    // SYSTEM_PROMPT and the project's AGENTS.md, not something the conversation decided. A session
    // created before src/agents/systemPrompt.ts existed has the old 29-character identity line
    // frozen into its JSON, and honouring it would resume with no tool guidance at all — the exact
    // failure that module exists to fix, on precisely the sessions a user upgrading already has.
    // Rebuilding also means an AGENTS.md edited since is picked up. It reads from the session's own
    // cwd rather than the process's, so a resume launched from elsewhere still gets the project's
    // file — the same reasoning as projectRoot(session.cwd) above.
    //
    // Two costs of rebuilding, neither of which the old replay-the-stored-string path had, both
    // accepted rather than guarded: this puts a readFileSync on the resume path, so an AGENTS.md
    // that exists but cannot be read (EACCES) now fails a resume that used to run; and if the
    // session's cwd has since been DELETED, findAgentsFile walks up from a missing directory and
    // adopts the nearest ancestor's AGENTS.md, which may belong to an unrelated project. Falling
    // back to the stored prompt on either is not an option worth having — the stored prompt is
    // exactly the 29-character string this rebuild exists to stop serving.
    //
    // `model` is backfilled only when absent, so a session that recorded one keeps it and the
    // environment cannot switch models under a conversation already running on one. Note what that
    // does NOT protect: a session written before the field existed was really running
    // llama-3.3-70b-versatile, nothing records that, and this first resume moves it to whatever
    // resolveModelId returns.
    return {
      session: {
        ...loaded,
        systemPrompt: buildSystemPrompt(loadAgentsFileFn(loaded.cwd)),
        model: loaded.model ?? resolveModelId(),
      },
      modelRecorded: loaded.model !== undefined,
    };
  }

  return {
    session: {
      id: randomUUID(),
      cwd: process.cwd(),
      systemPrompt: buildSystemPrompt(loadAgentsFileFn(process.cwd())),
      // approve-each, not read-only: on native Windows the OS sandbox is not enforced
      // (docs/ARCHITECTURE.md:417), so the permission gate is the whole Base layer and a default
      // that does not ask is a default that writes unattended. read-only was tried and measured —
      // a fresh session given a write task was blocked repeatedly and produced nothing (step 0 of
      // the tui-ready-permissions loop: 5 denials, done: no-tool-call, no file created). This
      // reverses docs/ARCHITECTURE.md:93's rejection of "approval for every edit" as a default;
      // the per-run allowlist ("always allow this tool", below) is what keeps this from being
      // that rejected every-call mode.
      permissionMode: "approve-each",
      model: resolveModelId(),
      messages: [],
    },
    modelRecorded: false,
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
// second press finds the slot empty and takes the fatal path, exactly as it would mid-stream —
// and it gets there as a real process signal rather than through this interface, because the abort
// listener below closes the readline, which puts the tty back out of raw mode and lets it generate
// SIGINT again.
//
// The onAbort registration is the other direction: a cancel that originated elsewhere while the
// prompt is up. Closing the interface and resolving "no" is what unparks the turn. The loop tells
// that "no" apart from a typed "n" by re-checking the signal, so the row the model sees says the
// call was cancelled rather than denied. A signal that is already aborted returns before the
// interface is opened — onAbort would catch that case too, that being the whole point of it, but a
// turn that has already been cancelled should not touch stdin to find out.

// write_file's input carries the whole file body, so an uncapped JSON.stringify can render
// hundreds of lines on one prompt line and scroll the question itself out of scrollback before the
// user can even see it, let alone answer it. Capped, not omitted: the prompt's job is still to
// show what is about to happen, just not all of it when "all of it" is unreadable anyway.
const MAX_PROMPT_ARGS_LENGTH = 200;
function truncateArgsDisplay(args: unknown): string {
  const json = JSON.stringify(args);
  return json.length > MAX_PROMPT_ARGS_LENGTH ? `${json.slice(0, MAX_PROMPT_ARGS_LENGTH)}…` : json;
}

function makeApprovalPrompt(
  // stderr, not stdout: stdout carries the model's own output and is routinely piped
  // (`seri "…" | tee log`) — see printWarning's own comment in cli/output.ts, the same rule.
  // Under the old read-only default the prompt was almost never reached; approve-each is the
  // default now, so a piped run hits this on its very first write, and the question must not be
  // swallowed into whatever consumed that pipe. Reads only from `input`, unchanged.
  openInterface: () => Interface = () => createInterface({ input: process.stdin, output: process.stderr }),
): ApprovalPrompt {
  // Once true, no further prompt in this run touches stdin at all. `process.stdin` is a single
  // shared stream that only ever emits 'end' once: the FIRST prompt's Interface is what actually
  // starts consuming it and discovers EOF, so its 'close' listener is the only one that will ever
  // fire. A second Interface opened on the same, already-ended stream attaches its own listeners
  // AFTER 'end' already happened — EventEmitters do not replay past events to a late listener — so
  // its 'close' never fires and its question's callback never runs: the promise hangs forever.
  // Measured live: prompt 1 resolves "no" correctly, prompts 2 and beyond hang. Denying every
  // prompt after the first EOF, without opening a doomed second Interface to rediscover that, is
  // Hermes' own rule for this applied at the point where it costs nothing extra to check first —
  // "on timeout or error, the approval bridge denies the request." Deliberately not a TTY check:
  // that would also kill `seri "explain this repo" | tee log`, a non-interactive run that only
  // reads and needs no approval at all; this only engages once stdin has actually ended.
  let ended = false;

  return (toolName, args, signal) =>
    new Promise<ApprovalAnswer>((resolve) => {
      if (signal?.aborted === true || ended) {
        resolve("no");
        return;
      }
      let answered = false;
      const rl = openInterface();
      const abort = onAbort(signal, () => {
        answered = true;
        rl.close();
        resolve("no");
      });
      // EOF on stdin — no tty, no data, `< /dev/null`, CI, a cron job — closes the interface
      // without rl.question's callback ever firing: readline emits 'close' and nothing else, so an
      // unguarded promise here hangs forever while signals.ts's process-level listeners keep the
      // event loop alive. An approval nobody can give is not an approval, so this resolves "no",
      // the same answer unrecognised input gets below — and marks the run as ended, so every later
      // prompt takes the guard above instead of opening a second Interface doomed the same way.
      // Guarded by `answered`, set before rl.close() runs in every other exit: rl.close() emits
      // 'close' SYNCHRONOUSLY, before the callback that called it goes on to resolve, so an
      // unguarded listener here would win that race and turn every real "y"/"a" into "no" instead
      // of only an actual close-with-no-answer. `abort.dispose()` here too — every other exit
      // either disposes it or is itself the abort, and this is the one path that used to leave the
      // listener attached to a long-lived AbortSignal for the rest of the run.
      rl.on("close", () => {
        if (!answered) {
          answered = true;
          ended = true;
          abort.dispose();
          resolve("no");
        }
      });
      rl.on("SIGINT", () => deliverSignal("SIGINT"));
      rl.question(
        `Approve ${escapeControlChars(toolName)}(${truncateArgsDisplay(args)})? [y]es / [a]lways / [N]o `,
        (answer) => {
          answered = true;
          abort.dispose();
          rl.close();
          const typed = answer.trim().toLowerCase();
          // Anything unrecognised is "no", exactly as the old [y/N] parse treated it: an approval a
          // user did not clearly give is not an approval.
          resolve(typed === "y" || typed === "yes" ? "once" : typed === "a" || typed === "always" ? "always" : "no");
        },
      );
    });
}

const PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  selftest: { type: "boolean" },
  resume: { type: "string" },
  continue: { type: "boolean" },
  "max-turns": { type: "string" },
  "dangerously-skip-permissions": { type: "boolean" },
} as const;

type ParsedArgs = {
  values: {
    help?: boolean;
    version?: boolean;
    selftest?: boolean;
    resume?: string;
    continue?: boolean;
    "max-turns"?: string;
    "dangerously-skip-permissions"?: boolean;
  };
  positionals: string[];
  maxTurns: number | undefined;
  skipPermissions: boolean;
};

// One convention across every handler below, so `run` reads as the sequence it is: a `number` is
// "handled, and this is seri's exit code", `undefined` is "not mine, carry on". The order they are
// called in is the behaviour — each was a guard clause inside one function before, and the three
// orderings that are load-bearing are named at their call sites.
function parseCliArgs(argv: string[]): ParsedArgs | number {
  let values: ParsedArgs["values"];
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: argv, strict: true, allowPositionals: true, options: PARSE_OPTIONS }));
  } catch (err) {
    return usageError(err instanceof Error ? err.message : String(err));
  }

  const maxTurnsRaw = values["max-turns"];
  let maxTurns: number | undefined;
  if (maxTurnsRaw !== undefined) {
    // parseArgs accepts --max-turns abc happily (measured) — it has no numeric option type — so
    // this check is not redundant. Same shape as isStepCount above. Validated here, right after the
    // parse, so a malformed value is a usage error regardless of which subcommand follows it —
    // `seri --max-turns garbage login` used to reach login with the bad flag silently ignored.
    if (!/^[1-9]\d*$/.test(maxTurnsRaw)) return usageError(`Invalid --max-turns value: ${maxTurnsRaw}`);
    maxTurns = Number(maxTurnsRaw);
  }

  // `--resume` now takes a mandatory value, so a slash command after it (`seri --resume /mode`,
  // the form `--resume`'s old optional-value parsing used to cycle the most recent session's mode)
  // looks for a session literally named "/mode" and fails with "session not found" instead — a
  // silent behaviour change rather than a loud one. Caught here as a usage error naming the fix.
  if (values.resume !== undefined && SLASH_COMMANDS.has(values.resume)) {
    return usageError(`--resume ${values.resume} looks for a session named "${values.resume}". Did you mean: seri --continue ${values.resume}`);
  }

  return { values, positionals, maxTurns, skipPermissions: values["dangerously-skip-permissions"] === true };
}

function handleInfoFlags(values: ParsedArgs["values"]): number | undefined {
  if (values.help === true) {
    console.log(USAGE);
    return 0;
  }
  if (values.version === true) {
    console.log(`seri ${pkg.version}`);
    return 0;
  }
  return undefined;
}

// Undocumented build-verification flag: the embedded ripgrep is vendored for the build
// host, so a cross-compiled binary can ship one that cannot run on the target. Spawning
// it for real is the only way to catch that from a shipped artifact; the release workflow
// runs this on every platform. Greps a throwaway file rather than the cwd so the result
// never depends on what happens to be in the directory seri was launched from.
async function runSelftest(deps: CliDeps): Promise<number> {
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

async function handleAuthCommand(positionals: string[], deps: CliDeps): Promise<number | undefined> {
  if (positionals[0] === "login" || positionals[0] === "signup") {
    const loginFn = deps.login ?? loginReal;
    try {
      const configDir = deps.authConfigDir ?? getConfigDir();
      await loginFn(positionals[0], getWorkosClientId(configDir), configDir);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
    return 0;
  }
  if (positionals[0] === "logout") {
    const logoutFn = deps.logout ?? logoutReal;
    try {
      logoutFn(deps.authConfigDir ?? getConfigDir());
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
    return 0;
  }
  return undefined;
}

function handleConfigCommand(positionals: string[], deps: CliDeps): number | undefined {
  if (positionals[0] !== "config") return undefined;
  const configCommandFn = deps.configCommand ?? configCommandReal;
  try {
    // Annotated and returned through a local, not `return configCommandFn(...)` directly. This
    // function's own return type has to admit `undefined` — that is how the dispatch in run() says
    // "not mine, carry on" — which means the compiler would accept an `undefined` arriving from
    // configCommand too, and run() would read it as "not handled". Before the decomposition this
    // call sat in `run(): Promise<number>` and widening it was a tsc error; the annotation is what
    // puts that error back. What it costs to lose is measured, not imagined: with a bare `return;`
    // added here, `seri config set GROQ_API_KEY gsk_live_…` falls through to the task path, mints a
    // session and writes `{"role":"user","content":"config set GROQ_API_KEY gsk_live_…"}` into the
    // session JSON — the key in full, on disk, and tsc stays green.
    const code: number = configCommandFn(positionals.slice(1), deps.authConfigDir ?? getConfigDir());
    return code;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

// What the task path needs after the subcommands have had their say. It extends CommandDirs, so it
// satisfies the two callees that take one structurally — but it is not handed to them whole:
// `dirs(ctx)` below narrows it back down at each call. Structural typing makes passing the whole
// thing legal and silent, so a slash command handler that asks for two directories would in fact
// receive the resume target and the task text as well — and whatever it grew to read from them
// would still typecheck against a signature saying it needs neither. Narrowing at the call site is
// what keeps the callee's declared contract the true one.
type RunContext = CommandDirs & {
  resuming: boolean;
  resumeId: string | undefined;
  taskText: string;
};

function dirs(ctx: RunContext): CommandDirs {
  return { sessionsDir: ctx.sessionsDir, checkpointsDir: ctx.checkpointsDir };
}

// A slash command always operates on the resume target — an explicit --resume id, or the most
// recent session — and never creates a session just to act on it, so this is called before
// prepareSession and a bare `/undo` (no --resume) does not fall into the new-session path. `/undo`
// and `/rewind` are keyed on the session's own `cwd`, not the current one, so running them from a
// different directory still finds the store the edits were recorded in.
function handleSlashCommand(ctx: RunContext): number | undefined {
  const [name = "", ...commandArgs] = ctx.taskText.split(/\s+/).filter(Boolean);
  const command = SLASH_COMMANDS.get(name);
  if (command === undefined || !command.accepts(commandArgs)) return undefined;

  const id = ctx.resumeId ?? findMostRecentSession(ctx.sessionsDir);
  if (!id) {
    console.error(`No session to run ${name} against.`);
    return 1;
  }
  try {
    command.run(loadSession<ModelMessage>(id, ctx.sessionsDir), commandArgs, dirs(ctx));
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

// Everything the loop is driven with, resolved before the first model call so a failure to build
// any of it is an exit code rather than a half-started turn.
type PreparedRun = {
  session: SessionState<ModelMessage>;
  storeDir: string;
  tools: ToolSet;
  model: LanguageModel;
  // Resolved here, the same way `model` is: a per-run fact the loop is driven with, carried
  // beside the session rather than assumed equal to `session.permissionMode`. `--dangerously-
  // skip-permissions` is the one thing that can make the two differ, and now that the value the
  // loop actually reads lives on this object instead of being re-derived at the call site, there
  // is no `session.permissionMode` assignment for a future edit to reach for by mistake — the
  // session this run started from is untouched, and driveLoop never sees anything else to assign.
  permissionMode: PermissionMode;
};

function prepareSession(ctx: RunContext, deps: CliDeps, skipPermissions: boolean): PreparedRun | number {
  const loadAgentsFileFn = deps.loadAgentsFile ?? loadAgentsFileReal;

  let session: RunSession;
  let modelRecorded: boolean;
  try {
    ({ session, modelRecorded } = loadOrCreateSession(ctx.resuming, ctx.resumeId, ctx.sessionsDir, loadAgentsFileFn));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (!ctx.resuming) console.log(`Session ${session.id} created.`);

  if (!ctx.resuming || ctx.taskText) {
    session.messages.push({ role: "user", content: ctx.taskText });
  }

  const getGroqModelFn = deps.getGroqModel ?? getGroqModelReal;
  let model;
  try {
    model = getGroqModelFn(session.model);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  // A model this run merely RESOLVED is deliberately left out of the file. getGroqModel accepts any
  // string — an unknown id is not rejected here, it comes back as a provider 404 mid-run — so
  // pinning at creation mints a session that can never succeed, and `--continue`, the obvious retry,
  // re-reads the bad id and fails identically while a corrected SERI_MODEL is ignored. driveLoop's
  // messages-updated save records it instead, which loop.ts only emits after a turn the provider
  // actually answered (loop.ts:264 for text, :276 for tool calls; a failure yields `error` and no
  // messages-updated at all), so what gets pinned is a model that demonstrably worked.
  //
  // opencode solves this upstream of the call, looking the id up in a provider catalog and failing
  // with `ModelNotFoundError` plus did-you-mean suggestions before anything is stored. seri has no
  // catalog until Stage 7a, so "pin only what answered" is the catalog-free half of that guarantee.
  // A model the session already recorded is untouched: it earned its place the same way.
  saveSession(modelRecorded ? session : { ...session, model: undefined }, ctx.sessionsDir);

  // Checkpointing is enabled by exactly this call, which is also why rolling it back is a one-line
  // revert: `runLoop`, the session store, the gate and every tool are unmodified, and the store
  // lives entirely outside the user's repository.
  const { storeDir, worktree } = checkpointTarget(session, dirs(ctx));

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

  // Verification is enabled by exactly this composition, and rolling it back is deleting the outer
  // call: `runLoop`, the gate, the session store and every tool are unmodified, and `verify/`
  // becomes dead code rather than something that has to be unpicked.
  //
  // Outside withCheckpoints, not inside: the checkpoint has to be taken BEFORE the write
  // (checkpoint/wrapTools.ts:18-22) and the check has to run AFTER it, so this is the order that
  // puts each on the correct side. The AbortSignal the check is run with is the one runLoop hands
  // `execute` (loop.ts:331), which is driveLoop's controller — the same Ctrl-C that stops a bash
  // command stops a check.
  const tools = withVerification(
    withCheckpoints(
      toolDefinitions,
      createCheckpointer({ storeDir, worktree, sessionId: session.id, onWarning: printWarning }),
    ),
    loadVerifyConfig(),
  );

  return { session, storeDir, tools, model, permissionMode: skipPermissions ? "auto" : session.permissionMode };
}

type DoneReason = Extract<LoopEvent, { type: "done" }>["reason"];

// undefined + n is n, not NaN, and undefined + undefined stays undefined: a run's total is the sum
// of the calls that reported, and stays unreported if none did.
function addTokens(total: number | undefined, reported: number | undefined): number | undefined {
  return reported === undefined ? total : (total ?? 0) + reported;
}

// `maxTurns` is an argument rather than a field of ctx: it is neither the resume target nor where
// its state lives, and this is the only place that reads it.
async function driveLoop(
  prepared: PreparedRun,
  ctx: RunContext,
  deps: CliDeps,
  maxTurns: number | undefined,
): Promise<{
  doneReason: DoneReason | undefined;
  cancelledBy: NodeJS.Signals | undefined;
  usage: RunUsage;
  // The one fact `run()`'s exit code actually needs, not the two inputs it would otherwise have
  // to reassemble itself: "refused at least once AND executed nothing at all" — see the tracking
  // below for what each half means and why.
  refusedWithoutRunning: boolean;
}> {
  const { session, storeDir, tools, model, permissionMode } = prepared;
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

  let doneReason: DoneReason | undefined;
  const usage: RunUsage = { inputTokens: undefined, outputTokens: undefined };
  // Tracked here, not in loop.ts: whether "no-tool-call" counts as success is a judgement about
  // what an exit code promises a shell, which is this consumer's business, not the loop's. A
  // `permission-denied` fires only on the `!approved` branch, which `continue`s past the tool-call
  // yield below it; `tool-call` fires only for a call that both passed the gate and had a real
  // tool definition (the unknown-tool branch also `continue`s past it) — so `hadDenial` and
  // `ranTool` are exactly "was anything refused" and "did anything actually run".
  let hadDenial = false;
  let ranTool = false;
  try {
    for await (const event of runLoopFn({
      model,
      tools,
      messages: session.messages,
      // Resolved once, in prepareSession, and carried on `prepared` the same way `model` is —
      // see PreparedRun's own comment. Reading it from there rather than re-deriving it here means
      // there is nothing this call site could assign into `session` even by accident.
      permissionMode,
      approvalPrompt: makeApprovalPrompt(deps.createInterface),
      system: session.systemPrompt,
      signal: controller.signal,
      maxIterations: maxTurns,
    })) {
      if (event.type === "messages-updated") {
        saveSession({ ...session, messages: event.messages }, ctx.sessionsDir);
        continue;
      }
      if (event.type === "permission-denied") hadDenial = true;
      if (event.type === "tool-call") ranTool = true;
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
      // `compacted` alongside `usage` because the summariser's own round-trip is billed like any
      // other call and was invisible to every caller until loop.ts stopped dropping it — a total
      // that left it out would under-report exactly the calls the user never asked for. Both
      // fields are `number | undefined` (the provider may report either, neither or both), which is
      // what addTokens carries through to the summary instead of flattening it to a zero.
      if (event.type === "usage" || event.type === "compacted") {
        usage.inputTokens = addTokens(usage.inputTokens, event.usage.inputTokens);
        usage.outputTokens = addTokens(usage.outputTokens, event.usage.outputTokens);
      }
      if (event.type === "done") doneReason = event.reason;
      printEvent(event);
    }
  } finally {
    // In a finally, so a run that throws out of the loop does not leave the slot pointing at a
    // controller nothing is waiting on — a later signal would then be swallowed as a cancel of a
    // turn that is no longer running instead of killing the process.
    unregisterCancel();
  }

  return { doneReason, cancelledBy, usage, refusedWithoutRunning: hadDenial && !ranTool };
}

export async function run(argv: string[], deps: CliDeps = {}): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (typeof parsed === "number") return parsed;
  const { values, positionals, maxTurns, skipPermissions } = parsed;

  const info = handleInfoFlags(values);
  if (info !== undefined) return info;

  if (values.selftest === true) return runSelftest(deps);

  // Bare `seri` is a placeholder for the interactive TUI that gates the v0.1.0 release. Until then
  // it prints the same usage as --help rather than exiting silently — a line the TUI entry point
  // replaces, not a decision that bare `seri` means "print usage". Any other flags-but-no-task
  // invocation (`seri --max-turns 5`) is a usage error instead: unlike bare `seri`, it named an
  // intention and cannot be silently taken as "show usage".
  if (positionals.length === 0 && values.continue !== true && values.resume === undefined) {
    if (argv.length === 0) {
      console.log(USAGE);
      return 0;
    }
    return usageError("No task given.");
  }

  const auth = await handleAuthCommand(positionals, deps);
  if (auth !== undefined) return auth;

  const config = handleConfigCommand(positionals, deps);
  if (config !== undefined) return config;

  const ctx: RunContext = {
    resuming: values.continue === true || values.resume !== undefined,
    resumeId: values.resume,
    taskText: positionals.join(" "),
    sessionsDir: deps.sessionsDir ?? join(getConfigDir(), "sessions"),
    checkpointsDir: deps.checkpointsDir ?? join(getConfigDir(), "checkpoints"),
  };

  // Before prepareSession, never after: a bare `/undo` must act on the resume target rather than
  // mint a session to act on.
  const slash = handleSlashCommand(ctx);
  if (slash !== undefined) return slash;

  const prepared = prepareSession(ctx, deps, skipPermissions);
  if (typeof prepared === "number") return prepared;

  const { doneReason, cancelledBy, usage, refusedWithoutRunning } = await driveLoop(prepared, ctx, deps, maxTurns);

  // Before raiseSignal, and outside the exit-code branch below, because every way out of driveLoop
  // spent the same tokens: a turn the user cancelled and a turn the provider failed mid-way are
  // billed for the calls they did make, and those are precisely the runs whose cost is otherwise
  // unaccounted for. The mid-stream failure reaches here because loop.ts reads that call's usage
  // before it returns — 907 tokens, measured, that this line would otherwise print without. The
  // one call nobody can report is an aborted one: the SDK rejects its usage promise with
  // AbortError, so a cancelled run reports every completed call before it and not that one. The
  // one exit this does not cover is a throw escaping driveLoop's `for await` (approvalPrompt
  // rejecting), which already skips the exit code below too.
  printUsage(usage);

  // The turn was cancelled, so the process still dies the way Ctrl-C makes a process die. Not
  // process.exit: a status is not a death by signal, and `for f in a b c; do seri "$f"; done` only
  // breaks out of the loop when the child was killed BY SIGINT — exiting 0 here would turn one
  // Ctrl-C into one press per iteration, the exact regression signals.ts's re-raise exists to
  // prevent. raiseSignal is that same re-raise, shared rather than re-implemented, and it does not
  // return, so the status below is for every other way this function ends.
  if (cancelledBy !== undefined) raiseSignal(cancelledBy);

  // Not "an error event was seen": loop.ts yields `error` and carries on at three sites, and a run
  // that recovered from a failed tool call and then answered the user did not fail. The status
  // answers one question — did the turn finish, and did it get anything past the gate? — and
  // `no-tool-call` is necessary but, since approve-each became the default, no longer sufficient:
  // a fresh session with no human present now reaches the approval prompt on its very first write,
  // EOF resolves "no", the model gives up and answers with text, and that used to exit 0 — asked
  // for permission, nobody was there, did nothing, reported success. `seri "…" && deploy` would
  // deploy. So within `no-tool-call`, `refusedWithoutRunning` — driveLoop's own conclusion from
  // "was anything refused" and "did anything actually run", refused at least once AND executed
  // nothing at all — is exit 1 too; a run with no tools and no denials (`seri "explain this
  // repo"`) and a run where one call was denied but a later one ran (the user said no to one
  // thing, the model did something else) both still exit 0, because both are a completed,
  // accomplished turn, not a refusal the caller should treat as failure.
  //
  // A cap is not a finish: `max-iterations` yields `done` having stopped with the user's task
  // unanswered, and `seri "big task" && deploy` must not deploy. `repeated-denials` is the same
  // fact by the same reasoning — the run stopped itself after MAX_CONSECUTIVE_DENIALS refused tool
  // calls, the task is exactly as unanswered as it would be at the iteration cap, and `&& deploy`
  // must not run off the back of it either — both stay unconditionally 1, regardless of
  // `refusedWithoutRunning`. loop.ts's two stream-error returns end the generator with no `done`
  // at all and land on the same 1 — a throw escaping runLoop outright (`approvalPrompt` rejecting, or
  // findSafeEvictionBoundary, neither of which is inside a try) ends it with no `done` too, but it
  // comes out of driveLoop's `for await` and never gets here. All of these used to exit 0 and let
  // `seri "…" && next` run next.
  //
  // `aborted` does not reach this line today, and that rests on `controller.abort()` having
  // exactly one caller: driveLoop's cancel handler, which sets cancelledBy first, so raiseSignal
  // ran and did not return. Nothing enforces it — signals.ts names Stage 6's subagents as a second
  // aborter — and a cancel arriving any other way lands on the 1 below rather than dying by
  // signal. tests/cli/cli.test.ts records that status for the displaced-slot case, but it asserts
  // the same 1 a second aborter would produce, so it will not go red when one is added: revisiting
  // this line is on whoever adds it.
  if (doneReason === "no-tool-call") return refusedWithoutRunning ? 1 : 0;
  return 1;
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
