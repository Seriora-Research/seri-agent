// Records what the seri TUI actually writes to and reads from a terminal, for questions
// drive-tui.mjs cannot answer: which mouse-reporting modes it turns on, whether it emits
// OSC 52, and what it does with a mouse drag. Run from the repo root with NODE, not bun
// (same ConPTY constraint drive-tui.mjs documents).
//
//   node .claude/skills/verify-seri/scripts/probe-mouse.mjs <out-dir> <profile> [step...]
//
// Steps, executed in order:
//   wait=TEXT       block until TEXT appears in the decoded output (20s deadline, `@MS` overrides)
//   type=TEXT       write TEXT to the terminal
//   key=NAME        esc | enter | ctrl-c | ctrl-d | ctrl-v | shift-tab | pageup | pagedown |
//                   up | down
//   sleep=MS        pause MS milliseconds
//   drag=C1,R1,C2,R2  press at (col,row) C1,R1, move to C2,R2, release — SGR 1006 encoding
//   click=C,R       press and release at one cell
//   wheel=up|down,C,R  one wheel notch at a cell
//
// Writes three files into <out-dir>: raw.bin (every byte the app wrote, verbatim),
// decoded.txt (the same stream as text), and report.json (private-mode enables, disables, saves
// and restores in arrival order, any OSC 52 payloads decoded from base64, and the child's exit
// code).
// Everything here is observation only — it never asserts, so a probe run has no pass/fail.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const pty = createRequire(join(ROOT, "apps/cli/package.json"))("node-pty");

// Named rather than written inline as \x1b and \x07: biome rejects a control character inside a
// regex, and a parser for terminal escapes has nothing else to match on.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

const KEYS = {
  esc: ESC,
  enter: "\r",
  "ctrl-c": "\x03",
  "ctrl-d": "\x04",
  "ctrl-v": "\x16",
  "shift-tab": `${ESC}[Z`,
  pageup: `${ESC}[5~`,
  pagedown: `${ESC}[6~`,
  up: `${ESC}[A`,
  down: `${ESC}[B`,
};

const SGR_PRESS = 0;
const SGR_RELEASE = 0;
const SGR_MOTION_LEFT = 32;
const SGR_WHEEL_UP = 64;
const SGR_WHEEL_DOWN = 65;

const sgr = (button, col, row, press) => `${ESC}[<${button};${col};${row}${press ? "M" : "m"}`;

const [outDir, profile, ...steps] = process.argv.slice(2);
if (!outDir || !profile) {
  console.error("usage: probe-mouse.mjs <out-dir> <profile> [step...]");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const term = pty.spawn("bun.exe", [join(ROOT, "apps/cli/src/cli.ts"), "--profile", profile], {
  cwd: ROOT,
  env: process.env,
  cols: 100,
  rows: 30,
});

const chunks = [];
let decoded = "";
let exited = false;
let childExit;
term.onData((data) => {
  chunks.push(data);
  decoded += data;
});
term.onExit(({ exitCode }) => {
  exited = true;
  childExit = exitCode;
});

function killOrphans() {
  if (process.platform !== "win32") return;
  const escaped = profile.replace(/'/g, "''");
  spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escaped}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ],
    { stdio: "ignore" },
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(text, deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (decoded.includes(text)) return true;
    if (exited) return decoded.includes(text);
    await sleep(50);
  }
  return false;
}

const misses = [];
for (const step of steps) {
  const [verb, ...restParts] = step.split("=");
  const arg = restParts.join("=");
  if (verb === "wait") {
    const at = arg.lastIndexOf("@");
    const hasDeadline = at !== -1 && /^\d+$/.test(arg.slice(at + 1));
    const text = hasDeadline ? arg.slice(0, at) : arg;
    const ms = hasDeadline ? Number(arg.slice(at + 1)) : 20000;
    if (!(await waitFor(text, ms))) misses.push(text);
  } else if (verb === "type") {
    term.write(arg);
  } else if (verb === "key") {
    term.write(KEYS[arg] ?? "");
  } else if (verb === "sleep") {
    await sleep(Number(arg));
  } else if (verb === "click") {
    const [c, r] = arg.split(",").map(Number);
    term.write(sgr(SGR_PRESS, c, r, true));
    await sleep(40);
    term.write(sgr(SGR_RELEASE, c, r, false));
  } else if (verb === "drag") {
    const [c1, r1, c2, r2] = arg.split(",").map(Number);
    term.write(sgr(SGR_PRESS, c1, r1, true));
    await sleep(40);
    const stepsX = Math.max(Math.abs(c2 - c1), Math.abs(r2 - r1), 1);
    for (let i = 1; i <= stepsX; i++) {
      const c = Math.round(c1 + ((c2 - c1) * i) / stepsX);
      const r = Math.round(r1 + ((r2 - r1) * i) / stepsX);
      term.write(sgr(SGR_MOTION_LEFT, c, r, true));
      await sleep(20);
    }
    await sleep(40);
    term.write(sgr(SGR_RELEASE, c2, r2, false));
  } else if (verb === "wheel") {
    const [dir, c, r] = arg.split(",");
    term.write(sgr(dir === "up" ? SGR_WHEEL_UP : SGR_WHEEL_DOWN, Number(c), Number(r), true));
  }
  await sleep(60);
}

await sleep(400);

// `s` and `r` (XTSAVE/XTRESTORE) take the same form as DECSET/DECRST's own `h`/`l`. The TUI no
// longer writes `?1007` itself (a wheel notch is Up/Down, and app.tsx routes those to the
// transcript). The parser still records save/restore if something else emits them, so an `h`/`l`
// consumer reads the report unchanged.
const PRIVATE_MODE = new RegExp(`${ESC}\\[\\?([\\d;]+)([hlsr])`, "g");
const MODE_ACTION = { h: "enable", l: "disable", s: "save", r: "restore" };
const OSC_52 = new RegExp(`${ESC}\\]52;([^;]*);([^${BEL}${ESC}]*)(?:${BEL}|${ESC}\\\\)`, "g");

const raw = chunks.join("");
const modes = [];
for (const m of raw.matchAll(PRIVATE_MODE)) {
  for (const code of m[1].split(";")) modes.push({ mode: Number(code), action: MODE_ACTION[m[2]] });
}
const osc52 = [];
for (const m of raw.matchAll(OSC_52)) {
  osc52.push({
    target: m[1],
    base64: m[2],
    text: m[2] === "?" ? null : Buffer.from(m[2], "base64").toString("utf8"),
  });
}

writeFileSync(join(outDir, "raw.bin"), Buffer.from(raw, "binary"));
writeFileSync(join(outDir, "decoded.txt"), decoded);
writeFileSync(
  join(outDir, "report.json"),
  `${JSON.stringify({ profile, steps, childExit, missedWaits: misses, modes, osc52 }, null, 2)}\n`,
);

console.error(
  `PROBE-RESULT missed=${misses.length} exit=${childExit ?? "killed"} modes=${modes.length} osc52=${osc52.length}`,
);

// Written before the kill on purpose: killOrphans() matches the profile name on any command
// line, and this process has it on its own, so it takes itself down along with the child.
// term.kill() is skipped on win32 for the reason drive-tui.mjs documents at its own finish().
if (process.platform !== "win32") {
  try {
    term.kill();
  } catch {}
}
killOrphans();
