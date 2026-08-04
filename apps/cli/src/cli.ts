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
  authConfigDir?: string;
  login?: typeof loginReal;
  logout?: typeof logoutReal;
  configCommand?: typeof configCommandReal;
  grep?: typeof grepReal;
};

function parseTaskArgs(argv: string[]): { resuming: boolean; resumeId: string | undefined; taskText: string } {
  const args = [...argv];
  const resumeIndex = args.indexOf("--resume");
  if (resumeIndex === -1) return { resuming: false, resumeId: undefined, taskText: args.join(" ").trim() };

  args.splice(resumeIndex, 1);
  const next = args[resumeIndex];
  // "/mode" is never a session id, even though it doesn't start with "-": it's the mode-
  // cycle command, and must fall through to the taskText below so `run()` can special-case
  // it against the resume target instead of throwing "session not found".
  const resumeId = next !== undefined && next !== "/mode" && !next.startsWith("-") ? next : undefined;
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

  const runLoopFn = deps.runLoop ?? runLoopReal;
  for await (const event of runLoopFn({
    model,
    tools: toolDefinitions,
    messages: session.messages,
    permissionMode: session.permissionMode,
    approvalPrompt: makeApprovalPrompt(),
    system: session.systemPrompt,
  })) {
    if (event.type === "messages-updated") {
      saveSession({ ...session, messages: event.messages }, sessionsDir);
      continue;
    }
    printEvent(event);
  }

  return 0;
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
