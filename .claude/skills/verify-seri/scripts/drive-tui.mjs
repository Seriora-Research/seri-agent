// Drives the seri TUI under a real pseudo-terminal (node-pty/ConPTY on Windows) and writes the
// decoded transcript to a file. Run from the repo root with NODE, not bun:
//
//   node .claude/skills/verify-seri/scripts/drive-tui.mjs <transcript-out> <profile> [cliArg...] :: <step...>
//
// Node is load-bearing: with bun as the node-pty host on this machine, every ConPTY child —
// even `cmd /c echo` — dies instantly with exit -1073741510 (STATUS_CONTROL_C_EXIT) after
// emitting only `?9001h?1004h`. Under node the same spawn works, console or no console.
// The CHILD is still bun (cli.ts is TypeScript).
//
// Everything between <profile> and `::` is passed to the seri CLI verbatim (e.g. --continue,
// --resume <id>). The `::` separator may be omitted when there are no extra CLI args.
// Steps, executed in order:
//   wait=TEXT       block until TEXT appears in the decoded output (20s deadline, exit 1 on miss)
//   wait=TEXT@MS    same with an explicit deadline (e.g. `wait=done ·@90000` for a model turn)
//   type=TEXT   write TEXT to the terminal
//   key=NAME    esc | enter | ctrl-c | ctrl-d | shift-tab | up | down
//               ctrl-e | ctrl-x | ctrl-p | ctrl-n | ctrl-up | ctrl-down (the message queue)
//   sleep=MS    pause MS milliseconds
//
// The child is `bun apps/cli/src/cli.ts --profile <profile>` with cwd = repo root, so the repo
// .env (GROQ_API_KEY) is loaded and the profile isolates config/sessions/permissions. The profile
// name doubles as the orphan-kill marker: pass a unique verify-<run-id> name, never a real one.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
// node-pty is installed under apps/cli (a devDependency there), not hoisted to the root.
const pty = createRequire(join(ROOT, "apps/cli/package.json"))("node-pty");

const KEYS = {
  esc: "\x1b",
  enter: "\r",
  "ctrl-c": "\x03",
  "ctrl-d": "\x04",
  "shift-tab": "\x1b[Z",
  up: "\x1b[A",
  down: "\x1b[B",
  // The message queue's own chords (tui/components/QueueBlock.tsx). ctrl-p/ctrl-n are not a
  // convenience alias for the arrows: a terminal that strips the arrow modifier delivers ctrl-down
  // as a plain down, which the input box reads as its own empty-Down, so the single-byte pair is
  // the only form that behaves identically everywhere.
  "ctrl-e": "\x05",
  "ctrl-x": "\x18",
  "ctrl-p": "\x10",
  "ctrl-n": "\x0e",
  "ctrl-up": "\x1b[1;5A",
  "ctrl-down": "\x1b[1;5B",
};

const [outFile, profile, ...rest] = process.argv.slice(2);
const sep = rest.indexOf("::");
const cliArgs = sep === -1 ? [] : rest.slice(0, sep);
const steps = sep === -1 ? rest : rest.slice(sep + 1);
if (!outFile || !profile || steps.length === 0) {
  console.error("usage: drive-tui.mjs <transcript-out> <profile> [cliArg...] :: <step...>");
  process.exit(2);
}

const term = pty.spawn(
  "bun.exe",
  [join(ROOT, "apps/cli/src/cli.ts"), "--profile", profile, ...cliArgs],
  {
    cwd: ROOT,
    env: process.env,
    cols: 100,
    rows: 30,
  },
);

let decoded = "";
let exited = false;
let childExit;
term.onData((data) => {
  decoded += data;
});
term.onExit(({ exitCode }) => {
  exited = true;
  childExit = exitCode;
});

// ConPTY's wrapped child is a separate OS process; term.kill() alone is not always enough
// (observed while building apps/cli/tests/tui/tuiPtyWindows.test.ts, which this mirrors).
// Matched by the unique profile name on the command line, never by image name.
function killOrphans() {
  if (process.platform !== "win32") return;
  const escaped = profile.replace(/'/g, "''");
  spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${escaped}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ],
    { timeout: 5_000 },
  );
}

function finish(code, message) {
  mkdirSync(dirname(resolve(outFile)), { recursive: true });
  writeFileSync(outFile, decoded);
  // The result line goes to stderr: under some hosting shells the ConPTY plumbing swallows this
  // process's stdout and even its exit code (255 observed on fully successful drives) — the
  // DRIVE-RESULT line and the transcript file are the reliable outcome signals, not the exit code.
  console.error(`DRIVE-RESULT code=${code}${message ? ` ${message}` : ""}`);
  // On Windows term.kill() forks node-pty's conpty_console_list_agent, whose AttachConsole call
  // fails here and crashes noisily (same behavior the repo's tuiPtyWindows.test.ts documents),
  // clobbering this process's own exit code. killOrphans() already kills the child by its unique
  // profile-name match, so the fork is skipped entirely on win32.
  if (process.platform !== "win32") {
    try {
      term.kill();
    } catch {}
  }
  killOrphans();
  process.exit(code);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const step of steps) {
  const eq = step.indexOf("=");
  const op = step.slice(0, eq);
  const arg = step.slice(eq + 1);
  if (op === "wait") {
    const m = arg.match(/^(.*)@(\d+)$/);
    const text = m ? m[1] : arg;
    const deadline = Date.now() + (m ? Number(m[2]) : 20_000);
    while (!decoded.includes(text) && !exited && Date.now() < deadline) await sleep(50);
    if (!decoded.includes(text)) {
      // -1073741510 (0xC000013A, STATUS_CONTROL_C_EXIT) with only "?9001h?1004h" captured means
      // the hosting process tree has no attached console and ConPTY cannot run here at all —
      // rerun from a standalone terminal window, not from an agent shell or Claude Code's `!`.
      finish(
        1,
        `wait=${JSON.stringify(arg)} never appeared${exited ? ` (child exited, code ${childExit})` : ""}`,
      );
    }
  } else if (op === "type") {
    term.write(arg);
  } else if (op === "key") {
    if (!(arg in KEYS)) finish(2, `unknown key: ${arg}`);
    term.write(KEYS[arg]);
  } else if (op === "sleep") {
    await sleep(Number(arg));
  } else {
    finish(2, `unknown step: ${step}`);
  }
}

// Give a graceful exit (from /exit or ctrl-d in the steps) a moment to land before teardown,
// then a margin for trailing bytes — the exit summary can arrive a beat after the process
// handle reports exited.
const deadline = Date.now() + 10_000;
while (!exited && Date.now() < deadline) await sleep(50);
if (exited) await sleep(300);
finish(0);
