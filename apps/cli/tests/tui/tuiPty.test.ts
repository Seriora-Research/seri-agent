import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CLI = pathToFileURL(join(import.meta.dir, "../../src/cli.ts")).href;

// The real cli.ts, same reason as tests/cli/approvalPromptPty.test.ts: `isTTY` has to come from a
// REAL process.stdout.isTTY on a real pty (the fix this session made to cli.ts requires it be
// passed explicitly — see CliDeps.isTTY's own comment — and a fake `true` would prove nothing about
// whether Ink's raw-mode input actually works). The fake runLoop waits on the AbortSignal rather
// than resolving on its own, so the turn is still "in flight" — and the TUI still mounted — when
// the Ctrl-C arrives.
function childScriptCancel(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  await new Promise((resolve) => opts.signal.addEventListener("abort", resolve, { once: true }));`,
    `  console.log("\\nRUNLOOP_ABORTED aborted=" + opts.signal.aborted);`,
    `  yield { type: "done", reason: "aborted" };`,
    `  return opts.messages;`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

// A runLoop that never settles, so the TUI stays mounted and interactive for as long as the test
// needs to type into it — nothing here is about the loop finishing, only about the input box and
// the slash-command dispatch wired in Phase 5.
function childScriptInput(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  await new Promise(() => {});`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

// Pins the `interactive: true` fix (cli.ts's own comment on its render() call): without it, Ink's
// own CI auto-detection (`is-in-ci`, keyed on the `CI`/`CONTINUOUS_INTEGRATION` env vars) treats a
// real pty as non-interactive whenever `CI` is set — exactly GitHub Actions' own default for every
// job — and stops live-rendering, regardless of `stdout.isTTY`. `CI=true` is set on the CHILD
// process only (this script's own first line), not on the test runner itself, so this reproduces
// the failure GitHub Actions' ubuntu-latest/macos-latest runners hit (confirmed by reverting
// `interactive: true` and re-running this exact test locally with `CI=true`: it hung on the
// `/mode` wait below until sawLine's own timeout, every time) without needing real CI to check it.
function childScriptCiEnv(dir: string): string {
  return [
    `process.env.CI = "true";`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  await new Promise(() => {});`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

// H-1/M-3: a session with no checkpoints at all, so `/undo 5` throws inside decideUndo — proving a
// command decision function's own exception is caught, not left to escape Ink's input handler.
// `/mode` sent afterward is what proves the process is still alive and responsive, not merely
// that it failed to crash outright. The turn resolves immediately (unlike the sibling scripts
// above, which hang on purpose) so `turnInFlight` clears before any command is sent — MEDIUM-3
// gates `/undo` while a turn is in flight, and this script tests `/undo`'s OWN throw, not that gate
// (which the dedicated MEDIUM-3 test below covers).
function childScriptCommandError(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

// H-2: a runLoop that throws on its very first iteration, once Ink has already mounted — proving
// runTui's driveLoop().catch() path unmounts and rejects rather than leaving run() awaiting a
// promise that was never going to settle.
function childScriptRejects(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  throw new Error("boom");`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

// H-3: a runLoop that resolves per call, reporting how many times it has been invoked and how
// many messages it was handed — the two facts that prove a second, free-form task submission
// actually re-invoked driveLoop against the LIVE (accumulated) session, rather than the TUI
// exiting after the first turn or a second turn starting from a fresh/stale message list.
function childScriptMultiTurn(dir: string): string {
  return [
    // HOME redirection (D9's own reasoning): this script never touches /model, so nothing here
    // should EVER write config.json — but the sibling test below needs to check the real
    // location that write would land at, and a bare, unredirected check would either be
    // meaningless or, if the guard were ever broken, land on the developer's real ~/.seri.
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `let calls = 0;`,
    `async function* runLoopFake(opts) {`,
    `  calls++;`,
    `  console.log("\\nRUNLOOP_CALL " + calls + " messages=" + opts.messages.length);`,
    `  yield { type: "messages-updated", messages: [...opts.messages, { role: "assistant", content: "ok " + calls }] };`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

// Stage 7a Slice 4: the actual /model bug fix, proven with a real second turn the same way
// childScriptMultiTurn proves H-3 above — a fake runLoop that reports which model id and how many
// messages EACH call actually received, so a live /model switch (a real picker, driven by real
// keystrokes) taking effect on the very next turn is observable from outside the process, not just
// asserted against the reducer in isolation. `getGroqModel` returns the id itself rather than an
// opaque `{}` (every OTHER script in this file's own convention) specifically so the fake runLoop
// can report which one it was actually handed. `SERI_DISABLE_MODELS_FETCH` keeps the catalog load
// prepareSession now always does (this same Slice) on the CLI's own bundled fallback manifest —
// deterministic, and no network dependency for a filter query this script needs to stay unique
// against.
function childScriptModelSwitch(dir: string): string {
  return [
    // D9: without this, a successful /model pick (this script's own point) calls
    // setConfigValue, whose default configDir is process.env.HOME || homedir() — unredirected,
    // that would rewrite the developer's REAL ~/.seri/config.json on every test run.
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `process.env.SERI_DISABLE_MODELS_FETCH = "1";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `let calls = 0;`,
    `async function* runLoopFake(opts) {`,
    `  calls++;`,
    `  console.log("\\nRUNLOOP_CALL " + calls + " model=" + opts.model.id + " messages=" + opts.messages.length + " systemHasModelId=" + opts.system.includes(opts.model.id));`,
    `  yield { type: "messages-updated", messages: [...opts.messages, { role: "assistant", content: "ok " + calls }] };`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: (id) => ({ id }),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

// D1/D2 (feature-plan.md, multi-provider-byok-phase-2): plan Test-plan item 8, "/model
// multi-route" — the end-to-end proof that decideModelPickerOpen's grouping (unit-tested already)
// and a real picker selection actually round-trip through a live pick to a persisted provider.
// Both `getGroqModel` and `getAnthropicModel` are injected so the picked route dispatches without
// needing a real key for either — resolveRoute (D2) leaves an explicit pick unchanged whenever
// NEITHER sibling in its route group has a configured key, which is the case here (only
// GROQ_API_KEY is set, and claude-sonnet-5's route group is anthropic/openrouter, not groq).
function childScriptModelMultiRoute(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `process.env.SERI_DISABLE_MODELS_FETCH = "1";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `let calls = 0;`,
    `async function* runLoopFake(opts) {`,
    `  calls++;`,
    `  console.log("\\nRUNLOOP_CALL " + calls + " model=" + opts.model.id + " provider=" + opts.provider);`,
    `  yield { type: "messages-updated", messages: [...opts.messages, { role: "assistant", content: "ok " + calls }] };`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: (id) => ({ id }),`,
    `  getAnthropicModel: (id) => ({ id }),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

// MEDIUM finding (code-review re-review on PR #71): loop.ts yields `messages-updated` once per
// tool call within a SINGLE turn (its own multiple yield sites), not once per turn — so this
// script's turn 2 yields it three times before `done`, simulating a turn with several tool calls,
// which the paired test below uses to prove a persistently-failing persist attempt is retried at
// most ONCE per turn, not once per `messages-updated` event within it.
function childScriptModelSwitchMultiToolCall(dir: string): string {
  return [
    // D9: same HOME redirection as childScriptModelSwitch's own comment — mandatory before
    // anything else runs.
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `process.env.SERI_DISABLE_MODELS_FETCH = "1";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `let calls = 0;`,
    `async function* runLoopFake(opts) {`,
    `  calls++;`,
    `  console.log("\\nRUNLOOP_CALL " + calls + " model=" + opts.model.id);`,
    `  if (calls === 2) {`,
    `    yield { type: "messages-updated", messages: [...opts.messages, { role: "assistant", content: "tool-call-1" }] };`,
    `    yield { type: "messages-updated", messages: [...opts.messages, { role: "assistant", content: "tool-call-2" }] };`,
    `    yield { type: "messages-updated", messages: [...opts.messages, { role: "assistant", content: "tool-call-3" }] };`,
    `    yield { type: "done", reason: "no-tool-call" };`,
    `    return opts.messages;`,
    `  }`,
    `  yield { type: "messages-updated", messages: [...opts.messages, { role: "assistant", content: "ok " + calls }] };`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: (id) => ({ id }),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

// B2/MEDIUM-5: the "pin only what worked" invariant applied to a live /model switch, proven the
// same real-keystroke way childScriptModelSwitch's own test proves the switch takes effect at all.
// Turn 1 succeeds normally on the starting model; turn 2 — on the model the real picker just
// switched to — fails with no `messages-updated` at all (the shape a bad key or an unreachable
// provider actually takes: loop.ts's own first catch yields `error` and returns, no `done`, no
// persist call for the TUI path — driveLoop's own comment on why persist is messages-updated-only).
// The script reads the on-disk session file itself, from inside this same process, once the failed
// call has yielded its `error` — proving what actually reached disk, not what the live reducer
// state (already switched, or the second RUNLOOP_CALL line would report the OLD model) merely says.
function childScriptModelSwitchFailure(dir: string): string {
  const sessionsDir = join(dir, "sessions");
  return [
    // D9: same HOME redirection as childScriptModelSwitch's own comment — mandatory before
    // anything else runs, so a stray persist here could never reach the developer's real config.
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `import { readdirSync, readFileSync } from "node:fs";`,
    `import { join } from "node:path";`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `process.env.SERI_DISABLE_MODELS_FETCH = "1";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `let calls = 0;`,
    `async function* runLoopFake(opts) {`,
    `  calls++;`,
    `  console.log("\\nRUNLOOP_CALL " + calls + " model=" + opts.model.id);`,
    `  if (calls === 1) {`,
    `    yield { type: "messages-updated", messages: [...opts.messages, { role: "assistant", content: "ok" }] };`,
    `    yield { type: "done", reason: "no-tool-call" };`,
    `    return opts.messages;`,
    `  }`,
    `  yield { type: "error", error: "simulated: no working key for this provider" };`,
    `  const sessionFile = readdirSync(${JSON.stringify(sessionsDir)}).find((f) => f.endsWith(".json"));`,
    `  const onDisk = JSON.parse(readFileSync(join(${JSON.stringify(sessionsDir)}, sessionFile), "utf8"));`,
    `  console.log("\\nMODEL_ON_DISK_AFTER_FAILURE " + onDisk.model);`,
    `  return opts.messages;`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: (id) => ({ id }),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(sessionsDir)},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

// D2/D3 (feature-plan.md, multi-provider-byok-phase-2): a session explicitly pinned to
// (claude-sonnet-5, openrouter) — the design doc's own motivating pair (routes.test.ts's own
// comment has the full story) — with only ANTHROPIC_API_KEY present and OPENROUTER_API_KEY
// deleted, so routing-priority resolution must reroute to the native Anthropic sibling on turn 1.
// The fake runLoop reports `opts.model.via` (which of the two injected constructors was actually
// called) and `opts.provider` (driveLoop's own resolved-pair argument, D3's fix to what used to
// read the REQUESTED pair) — two independent signals that the reroute actually took effect, not
// just that SOME model answered.
function childScriptReroute(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.SERI_MODEL = "anthropic/claude-sonnet-5";`,
    `process.env.SERI_PROVIDER = "openrouter";`,
    `process.env.ANTHROPIC_API_KEY = "fake-test-key";`,
    `delete process.env.OPENROUTER_API_KEY;`,
    `delete process.env.GROQ_API_KEY;`,
    `process.env.SERI_DISABLE_MODELS_FETCH = "1";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `let calls = 0;`,
    `async function* runLoopFake(opts) {`,
    `  calls++;`,
    `  console.log("\\nRUNLOOP_CALL " + calls + " via=" + opts.model.via + " provider=" + opts.provider);`,
    `  yield { type: "messages-updated", messages: [...opts.messages, { role: "assistant", content: "ok " + calls }] };`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getOpenRouterModel: (id) => ({ id, via: "or" }),`,
    `  getAnthropicModel: (id) => ({ id, via: "anthropic" }),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

// The negative-control sibling of childScriptReroute, just above: identical pinned pair, but
// OPENROUTER_API_KEY is present too (alongside ANTHROPIC_API_KEY) — D2 rule 1 says an explicit
// pick with its own key wins even when a native sibling also has one, so this must stay on
// OpenRouter and never print a reroute notice at all.
function childScriptNoReroute(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.SERI_MODEL = "anthropic/claude-sonnet-5";`,
    `process.env.SERI_PROVIDER = "openrouter";`,
    `process.env.ANTHROPIC_API_KEY = "fake-test-key";`,
    `process.env.OPENROUTER_API_KEY = "fake-test-key";`,
    `delete process.env.GROQ_API_KEY;`,
    `process.env.SERI_DISABLE_MODELS_FETCH = "1";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `let calls = 0;`,
    `async function* runLoopFake(opts) {`,
    `  calls++;`,
    `  console.log("\\nRUNLOOP_CALL " + calls + " via=" + opts.model.via + " provider=" + opts.provider);`,
    `  yield { type: "messages-updated", messages: [...opts.messages, { role: "assistant", content: "ok " + calls }] };`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getOpenRouterModel: (id) => ({ id, via: "or" }),`,
    `  getAnthropicModel: (id) => ({ id, via: "anthropic" }),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

// HIGH-1: a turn that finishes and reports usage, then the TUI is left awaiting input — proving
// `run()` actually reaches `printUsage`/the exit-code logic on the TUI path once /exit or Ctrl-D
// resolves runTui's promise, which nothing did before this fix.
function childScriptQuit(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  yield { type: "usage", usage: { inputTokens: 12, outputTokens: 34 } };`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `const code = await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
    `console.log("\\nEXIT_CODE " + code);`,
  ].join("\n");
}

// HIGH-B: parks mid-turn, after reporting real usage, waiting on the SAME abort signal
// childScriptCancel's fake runLoop waits on — proving /exit cancels an in-flight turn (via the
// same deliverSignal("SIGINT") path a single Ctrl-C already uses) rather than abandoning it.
function childScriptQuitMidTurn(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  yield { type: "usage", usage: { inputTokens: 12, outputTokens: 34 } };`,
    `  await new Promise((resolve) => opts.signal.addEventListener("abort", resolve, { once: true }));`,
    `  console.log("\\nRUNLOOP_ABORTED aborted=" + opts.signal.aborted);`,
    `  yield { type: "done", reason: "aborted" };`,
    `  return opts.messages;`,
    `}`,
    `const code = await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
    `console.log("\\nEXIT_CODE " + code);`,
  ].join("\n");
}

// MEDIUM-C: two clean turns, each reporting its own usage, proving the final summary (printed
// after /exit) sums every turn rather than just the last one.
function childScriptMultiTurnUsage(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `let calls = 0;`,
    `async function* runLoopFake(opts) {`,
    `  calls++;`,
    `  console.log("\\nRUNLOOP_CALL " + calls);`,
    `  yield { type: "usage", usage: { inputTokens: 10 * calls, outputTokens: 20 * calls } };`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `const code = await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
    `console.log("\\nEXIT_CODE " + code);`,
  ].join("\n");
}

// LOW-4/MEDIUM-1: a still-in-flight turn that yields a SECOND messages-updated after a mid-turn
// /mode change — the exact shape of the regression MEDIUM-1 fixed. Pre-fix, driveLoop's own
// direct saveSession call on that second event used the turn-start (pre-/mode) session and
// clobbered the on-disk file back to the old mode; post-fix, driveLoop's persist callback is a
// no-op on the TUI path, so nothing but the reducer's own effect ever writes here. `flagPath`
// gates the second yield so the test can release it only once the FIRST write (the /mode
// command's own) is confirmed on disk.
//
// HIGH-A: round 3's version of this script waited for the transcript's own "(done: ...)" line
// before its one disk read — by which point the reducer's own onSessionChange effect for the
// SECOND messages-updated had already had its own chance to run and correct any stale write,
// regardless of whether one happened. Mutation-tested (the exact pre-fix stale saveSession call
// restored into driveLoop): that version stayed green. This version instead reads the session
// file SYNCHRONOUSLY, from inside this same process, as the very first statement once the
// generator resumes past the second yield — which is only after driveLoop's own synchronous
// persist()+dispatch() call for that event has already run, and (mutation-tested the same way,
// this time confirmed red before green below) before React's own effect scheduler has had a
// chance to flush the reducer's correction. `MODE_AT_RESUME` reports exactly what driveLoop's own
// synchronous work left on disk at that instant, not what it eventually settles to.
function childScriptModePersistence(dir: string, flagPath: string): string {
  const sessionsDir = join(dir, "sessions");
  return [
    `import { existsSync, readFileSync, readdirSync } from "node:fs";`,
    `import { join } from "node:path";`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  yield { type: "messages-updated", messages: opts.messages };`,
    `  console.log("\\nRUNLOOP_MSG1");`,
    `  await new Promise((resolve) => {`,
    `    const check = () => { if (existsSync(${JSON.stringify(flagPath)})) resolve(); else setTimeout(check, 20); };`,
    `    check();`,
    `  });`,
    `  yield { type: "messages-updated", messages: opts.messages };`,
    `  const sessionFile = readdirSync(${JSON.stringify(sessionsDir)}).find((f) => f.endsWith(".json"));`,
    `  const modeAtResume = JSON.parse(readFileSync(join(${JSON.stringify(sessionsDir)}, sessionFile), "utf8")).permissionMode;`,
    `  console.log("\\nMODE_AT_RESUME " + modeAtResume);`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(sessionsDir)},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

// Design-question fix (this PR's own follow-up): a runLoop that streams text in two parts with a
// gap in between, released by the same flag-file pattern childScriptModePersistence uses, so a
// /rewind sent during that gap (rejected by MEDIUM-3's turnInFlight check) lands while the model's
// answer is genuinely still in progress — not resolved yet, same as the mode-persistence script's
// own reasoning for using a flag file instead of a fixed delay.
function childScriptRewindDuringStream(dir: string, flagPath: string): string {
  return [
    `import { existsSync } from "node:fs";`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  yield { type: "text-delta", text: "Hello " };`,
    `  console.log("\\nSTREAM_PART_1");`,
    `  await new Promise((resolve) => {`,
    `    const check = () => { if (existsSync(${JSON.stringify(flagPath)})) resolve(); else setTimeout(check, 20); };`,
    `    check();`,
    `  });`,
    `  yield { type: "text-delta", text: "world" };`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

// D5-D8 (feature-plan.md): /setup's own real-pty harness — a never-resolving runLoop (mirrors
// childScriptInput's own shape) so the TUI stays interactive for as long as a test needs. Every
// /setup script sets HOME (D9's own reasoning, so a write never touches the developer's real
// ~/.seri), SERI_DISABLE_MODELS_FETCH (deterministic catalog), and SERI_SKIP_KEY_VALIDATION=1 (D5's
// own escape hatch — no /setup test ever touches the network). GROQ_API_KEY is set as a real env
// var, same as every other script in this file — the groq ROW reads `source: "env"` because of it,
// which some of the tests below rely on precisely because it is NOT the row under test.
function childScriptSetup(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.SERI_DISABLE_MODELS_FETCH = "1";`,
    `process.env.SERI_SKIP_KEY_VALIDATION = "1";`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  await new Promise(() => {});`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

// The env-shadow scenario's own script (item 7, feature-plan.md): unlike childScriptSetup, this
// one exports OPENAI_API_KEY as a real env var AND pre-seeds a DIFFERENT value into config.json
// (below, host-side, before spawn) — D8's own point is that env wins the SOURCE regardless of
// whether a config entry also exists underneath.
function childScriptSetupEnvShadow(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.SERI_DISABLE_MODELS_FETCH = "1";`,
    `process.env.SERI_SKIP_KEY_VALIDATION = "1";`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `process.env.OPENAI_API_KEY = "sk-openai-env-value";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  await new Promise(() => {});`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

// Findings 1+5 (thermo-nuclear structural review, round 6): the TUI-native approval prompt — the
// research spec's own ORIGINAL design for this ("a TUI supplies a different function of the
// identical signature... with zero change to loop.ts/gate.ts") that every earlier round of this
// branch left unbuilt, leaving the TUI path calling makeApprovalPrompt's readline-based prompt
// instead (a SECOND stdin consumer racing Ink's own raw-mode ownership). Same shape as
// tests/cli/approvalPromptPty.test.ts's own childScript, calling `opts.approvalPrompt` directly —
// the fake runLoop stands in for the model round-trip, and the ONLY thing under test is the
// approval wiring: does it reach the screen, and does a keypress actually unblock the turn.
function childScriptApproval(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  const answer = await opts.approvalPrompt("write_file", { path: "a.txt", content: "hi" }, opts.signal);`,
    `  console.log("\\nPROMPT_ANSWER " + answer);`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

type Exit = { code: number | null; signal: NodeJS.Signals | null; stdout: string };

// Identical shape to tests/cli/approvalPromptPty.test.ts's own startChild — duplicated rather than
// imported, matching this repo's convention of self-contained pty test files. See that file's own
// comment for why a pty (not a pipe) is load-bearing here: raw mode's interpretation of input —
// both 0x03 as a keypress rather than a signal, and each typed character reflecting live — is the
// entire mechanism under test, and a pipe cannot exercise either.
function startChild(
  scriptPath: string,
  cwd: string,
): {
  child: ReturnType<typeof spawn>;
  exited: Promise<Exit>;
  sawLine: (line: string) => Promise<void>;
  // MEDIUM-C: the transcript prints the identical "(done: no-tool-call)" line for every turn in a
  // multi-turn session, so `sawLine` (a plain substring check) is already true for turn 2's own
  // occurrence the instant turn 1's happens — this counts occurrences instead, so a caller can
  // wait for the SECOND (or Nth) one specifically rather than racing turn 2's own completion
  // against an assertion that turn 1 alone already satisfies.
  sawLineTimes: (line: string, count: number) => Promise<void>;
  occurrences: (line: string) => number;
} {
  const args = ["-c", "import pty, sys; pty.spawn(sys.argv[1:])", process.execPath, scriptPath];
  const child = spawn("python3", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });

  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });

  let spawnError: Error | undefined;
  const exited = new Promise<Exit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal, stdout }));
    child.once("error", (err) => {
      spawnError = err;
      resolve({
        code: null,
        signal: null,
        stdout: `could not spawn python3 (pty allocator): ${err.message}`,
      });
    });
  });

  const occurrences = (line: string): number => stdout.split(line).length - 1;

  const sawLine = async (line: string): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (!stdout.includes(line) && spawnError === undefined && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    if (spawnError !== undefined)
      throw new Error(`could not spawn python3 (pty allocator): ${spawnError.message}`);
    if (!stdout.includes(line))
      throw new Error(`child never printed ${JSON.stringify(line)}; got ${JSON.stringify(stdout)}`);
  };

  const sawLineTimes = async (line: string, count: number): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (occurrences(line) < count && spawnError === undefined && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    if (spawnError !== undefined)
      throw new Error(`could not spawn python3 (pty allocator): ${spawnError.message}`);
    if (occurrences(line) < count)
      throw new Error(
        `child printed ${JSON.stringify(line)} ${occurrences(line)} time(s), wanted ${count}; got ${JSON.stringify(stdout)}`,
      );
  };

  return { child, exited, sawLine, sawLineTimes, occurrences };
}

// Windows has no pty to allocate — same constraint as approvalPromptPty.test.ts. Real execution is
// the WSL box and CI's ubuntu/macos legs; a green Windows run means this case SKIPPED.
describe.skipIf(process.platform === "win32")("the Ink TUI on a real terminal", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seri-pty-tui-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The TUI counterpart of approvalPromptPty.test.ts's "a real Ctrl-C at the prompt cancels the
  // turn" test — same fact (a single press cancels the in-flight turn rather than being silently
  // dropped), different route to signals.ts: there is no readline Interface in the TUI path, so
  // this exercises App.tsx's own onCancel handler and runTui's exitOnCtrlC: false instead (Ink's
  // default exitOnCtrlC would otherwise unmount the app on the same press, competing with the
  // cancel this asserts on).
  //
  // Asserted on stdout, not on the process exiting: H-3's multi-turn wiring means a cancelled turn
  // returns the TUI to "awaiting input" rather than ending the process (only a fatal Ctrl-C does
  // that — see the "second Ctrl-C" test below). Confirmed for real on a pty (WSL2) that the
  // process does NOT exit here: driveLoop resolves, runTurn's `finally` clears turnInFlight, and
  // the process sits waiting for more input until the harness kills it in `finally` — an earlier
  // version of this test raced `exited` instead and hung for the full timeout every time, which is
  // what this comment now documents rather than an assertion that stopped matching H-3's own
  // behavior.
  test("a single Ctrl-C during an Ink-driven run cancels the turn instead of killing the process outright", async () => {
    const scriptPath = join(dir, "child-cancel.mjs");
    writeFileSync(scriptPath, childScriptCancel(dir));

    const { child, sawLine, occurrences } = startChild(scriptPath, dir);
    try {
      // Waiting for the fake runLoop's own readiness line is also what keeps the byte out of the
      // window before Ink sets raw mode (useInput's mount effect calls setRawMode(true)) — driveLoop
      // only reaches runLoopFake after runTui's connectDispatch effect has already fired, which is
      // after every mount effect from that same commit, useInput's included, has already run. While
      // the pty is still canonical, 0x03 would raise a real SIGINT and the test would pass for the
      // wrong reason — same reasoning as approvalPromptPty.test.ts's own "[a]lways" wait.
      await sawLine("RUNLOOP_READY");
      // connectDispatch's own echo of the initial argv task ("do a task", this file's own
      // cli.run(["do", "a", "task"], ...) argv) — covered here, not a dedicated test, since every
      // child script in this file already launches with the same argv and this is the first test
      // to reach RUNLOOP_READY. Dispatched before RUNLOOP_READY's own console.log (connectDispatch
      // echoes, then calls runTurn, which is what reaches the fake runLoop), but the echo only
      // reaches the pty once Ink commits the <Static> update — waited on explicitly rather than
      // read immediately, same reasoning as the second-turn test's own sawLineTimes wait below.
      await sawLine("> do a task");
      expect(occurrences("> do a task")).toBe(1);
      child.stdin?.write("\x03");
      // stdin is deliberately left open, same reason as the sibling file: an EOF would end the run
      // its own way, before the press is ever interpreted.
      await sawLine("RUNLOOP_ABORTED aborted=true");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // Raw-mode multiline input, smoke-level: a slash command typed character-by-character into
  // Phase 4's input box is reflected live (proving raw mode, not readline's line-buffered cooked
  // mode, is what is driving this), and Enter submits it through Phase 5's decision/presentation
  // wiring — the same tuiPresenter path /mode, /undo, /restore and /rewind all share. Enter is "\r"
  // (carriage return), not "\n": Ink's own parse-keypress.js maps "\r" to key.name "return" (what
  // InputBox's `key.return` check reads) and "\n" to a different name, "enter", which InputBox does
  // not recognise — the raw-mode counterpart of readline's own "\n"-terminated convention used
  // elsewhere in this repo's pty tests, not a typo.
  test("typing a slash command into the input box, then Enter, dispatches it through the Phase 5 wiring", async () => {
    const scriptPath = join(dir, "child-input.mjs");
    writeFileSync(scriptPath, childScriptInput(dir));

    const { child, sawLine, occurrences } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");

      child.stdin?.write("/mode");
      // Reflected live in the input box's own rendered frame — proof raw mode is actually driving
      // this, not just that the command eventually took effect.
      await sawLine("/mode");

      child.stdin?.write("\r");
      // decideModeCycle (tui/commands.ts, Phase 2) cycling a fresh session's default
      // permissionMode ("approve-each") one step, dispatched into the transcript by tuiPresenter
      // (Phase 5) rather than console.log'd — this line only appears if that whole chain ran.
      await sawLine("permission mode is now auto");
      // The submitted command itself, echoed into the persistent transcript exactly once — not
      // just its result. onSubmit's own transcript-append dispatch, before the command dispatch.
      // Waited on explicitly before reading occurrences(), same as the argv-task and second-task
      // echo checks elsewhere in this file: the echo lands via an async <Static> commit, not
      // synchronously with the dispatch that triggered it.
      await sawLine("> /mode");
      expect(occurrences("> /mode")).toBe(1);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // H-1 + M-3: a command decision function throwing (no checkpoints to /undo to) used to escape
  // straight out of Ink's own input handler. Confirmed here two ways — the error is shown, not
  // silently dropped, AND the process is still alive and answers a second, unrelated command
  // afterward, which a crash would not. M-3's other case — input shaped like a slash command that
  // matches nothing at all (a typo) — is checked in the same run, since it needs the same fixture.
  test("a slash command that throws, or one that matches nothing, shows an error line instead of crashing the TUI", async () => {
    const scriptPath = join(dir, "child-command-error.mjs");
    writeFileSync(scriptPath, childScriptCommandError(dir));

    const { child, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      // Turn resolves right away (this script's own comment explains why) — waited for here so
      // `/undo 5` below exercises decideUndo's own throw, not MEDIUM-3's turn-in-flight gate.
      await sawLine("(done: no-tool-call)");

      // M-3: a typo'd command name matches nothing in SLASH_COMMANDS at all.
      child.stdin?.write("/mdoe");
      await sawLine("/mdoe");
      child.stdin?.write("\r");
      await sawLine("Unrecognized command: /mdoe");

      // H-1: a name that DOES match, but throws inside its own decision function.
      child.stdin?.write("/undo 5");
      await sawLine("/undo 5");
      child.stdin?.write("\r");
      await sawLine("checkpoint(s) to undo to; asked for 5");

      // Still alive: an ordinary command sent right after both of the above still works.
      // cycleMode (gate/gate.ts) cycles approve-each -> auto -> read-only -> approve-each, and a
      // fresh session starts at approve-each (the [approve-each] indicator shown on mount), so
      // this first /mode press lands on auto, not read-only.
      child.stdin?.write("/mode");
      await sawLine("/mode");
      child.stdin?.write("\r");
      await sawLine("permission mode is now auto");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // MEDIUM-D: "/exit the debugger and retry" is a task whose first word happens to be /exit, not
  // a request to quit — used to be hijacked into one regardless of the trailing words. Confirmed
  // two ways: the error is shown (not a silent quit), and the process is still alive and answers
  // an unrelated command afterward, which quitting would not.
  test("/exit with trailing arguments is rejected rather than quitting the TUI", async () => {
    const scriptPath = join(dir, "child-exit-hijack.mjs");
    writeFileSync(scriptPath, childScriptCommandError(dir));

    const { child, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      await sawLine("(done: no-tool-call)");

      child.stdin?.write("/exit the debugger and retry");
      await sawLine("/exit the debugger and retry");
      child.stdin?.write("\r");
      await sawLine("/exit: invalid arguments.");

      // Still alive — quitting would leave nothing to answer this.
      child.stdin?.write("/mode");
      await sawLine("/mode");
      child.stdin?.write("\r");
      await sawLine("permission mode is now auto");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // H-2: driveLoop rejecting (a real throw, not just an aborted/errored `done` event) is a
  // distinct failure mode from every other exit this file tests — runTui's own catch has to
  // unmount and reject rather than leave run()'s own `await runTui(...)` parked forever. Asserted
  // by the child process actually exiting within the deadline rather than hanging; run() has no
  // try/catch of its own around that await (matching the non-interactive path's own documented
  // behavior for a throw escaping driveLoop's for-await), so this surfaces as the child process
  // itself ending, one way or another, not as a value run() returns.
  test("driveLoop rejecting settles run() instead of hanging forever", async () => {
    const scriptPath = join(dir, "child-rejects.mjs");
    writeFileSync(scriptPath, childScriptRejects(dir));

    const { exited, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");

      const settled = await Promise.race([
        exited,
        new Promise<"the run never settled">((r) =>
          setTimeout(() => r("the run never settled"), 15_000),
        ),
      ]);

      expect(settled).not.toBe("the run never settled");
    } finally {
      // Already exited in the success case; harmless if the process is already gone.
    }
  }, 60_000);

  // H-3: submitting free-form text (not a recognised slash command) after the first turn
  // completes starts a SECOND driveLoop call against the live, accumulated session, and the TUI
  // does not exit between the two turns — feature-plan.md's own acceptance criterion ("the next
  // model turn reads" a live-updated session), demonstrated with a real second turn rather than
  // just the reducer merge C-1 already covers.
  test("a second, free-form task submission starts another turn against the accumulated session", async () => {
    const scriptPath = join(dir, "child-multi-turn.mjs");
    writeFileSync(scriptPath, childScriptMultiTurn(dir));

    const { child, sawLine, sawLineTimes, occurrences } = startChild(scriptPath, dir);
    try {
      // prepareSession appended the initial task as the session's only message.
      await sawLine("RUNLOOP_CALL 1 messages=1");
      // Turn 1's own "done" — not "ok 1" (the fake runLoop's assistant reply content): that lives
      // only in session.messages via the reducer's messages-updated merge, never rendered to the
      // transcript, the same as a real model reply's own content is never echoed back by
      // messages-updated (tui/reducer.ts's own case, and printEvent's identical no-op for the
      // non-interactive path). Waiting for "done" here is what actually matters: it is only
      // dispatched after driveLoop's own for-await loop has fully returned, so by the time it
      // appears, turnInFlight has cleared (the input box will accept a new submission) and
      // onSessionChange has already run for turn 1's own messages-updated (its dispatch strictly
      // precedes "done"'s in the same driveLoop call), so liveSession already carries the turn-1
      // assistant reply before task 2 is submitted.
      await sawLine("(done: no-tool-call)");

      child.stdin?.write("a second task");
      // Reflected live in the input box's own rendered frame first, same as the raw-mode-input
      // test above — sending "\r" immediately after, with no wait for the text to actually land,
      // measured (on a real pty) to lose the Enter press entirely: the box was left showing "a
      // second task" unsubmitted and no second driveLoop call ever happened, this test hanging to
      // its own timeout every time. Root cause not further isolated beyond that reproduction; the
      // fix is the same one every other input-driven test in this file already applies.
      await sawLine("a second task");
      child.stdin?.write("\r");

      // 1 initial + 1 turn-1 assistant reply + 1 new user message = 3, and the app is still
      // running to report it at all — proof it did not exit after the first turn.
      await sawLine("RUNLOOP_CALL 2 messages=3");
      // The second task's own text, echoed into the persistent transcript exactly once — the
      // input box's live reflection (waited on above) is not the same thing as the submitted
      // line actually landing in Static. Waited on explicitly (not just re-checked via
      // occurrences() below): the echo reaches the pty only once Ink commits the <Static> update,
      // a scheduler macrotask after RUNLOOP_CALL 2's own console.log, so reading occurrences()
      // without waiting first can race it on a slow/loaded runner.
      await sawLineTimes("> a second task", 1);
      expect(occurrences("> a second task")).toBe(1);

      // Scenario c at the TUI level (feature-plan.md): a session that never invokes /model must
      // never persist anything to config.json, even after multiple successful turns — the guard
      // against write-amplification/accidentally-always-persisting. Waiting for turn 2's own
      // "done" first is what makes this meaningful: it is only dispatched after turn 2's
      // messages-updated has already been processed (the same ordering childScriptModelSwitch's
      // own test relies on), so any persist that WOULD have fired already has by this point.
      await sawLineTimes("(done: no-tool-call)", 2);
      expect(existsSync(join(dir, ".seri", "config.json"))).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // Stage 7a Slice 4: the concrete mechanical proof of "context preserved" — a real /model switch,
  // driven by real keystrokes through the actual picker (not a synthetic reducer dispatch), takes
  // effect on the very next turn (a different model id is what the SECOND RUNLOOP_CALL reports),
  // while the message array driveLoop is handed keeps growing exactly as childScriptMultiTurn's own
  // sibling test above already proves it does without a switch — 3, not reset or corrupted by the
  // model change in between.
  test("switching the model via /model re-resolves the model on the very next turn without touching accumulated messages", async () => {
    const scriptPath = join(dir, "child-model-switch.mjs");
    writeFileSync(scriptPath, childScriptModelSwitch(dir));

    const { child, sawLine, sawLineTimes } = startChild(scriptPath, dir);
    try {
      // The default model (groq.ts's own DEFAULT_MODEL) — proves the FIRST turn used it, before
      // any switch.
      await sawLine("RUNLOOP_CALL 1 model=openai/gpt-oss-120b messages=1 systemHasModelId=true");
      await sawLine("(done: no-tool-call)");

      child.stdin?.write("/model");
      await sawLine("/model");
      child.stdin?.write("\r");
      // The picker replaces the input box (App.tsx's own three-way mutual exclusion) — the bundled
      // fallback manifest's own default model is one of the 6 groq entries, always inside the
      // picker's default (unfiltered) top-10 window regardless of catalog ordering, so this is a
      // reliable sync point proving the picker actually mounted before typing a filter.
      await sawLine("GPT OSS 120B");

      // Narrows to exactly one entry across the WHOLE catalog (groq and openrouter both) — verified
      // directly against the bundled catalog-manifest.json before writing this string; "3.3-70b"
      // alone also matches an OpenRouter entry, "70b-versatile" does not.
      child.stdin?.write("70b-versatile");
      await sawLine("70b-versatile");
      child.stdin?.write("\r");
      // The Enter keypress resolves synchronously (App.tsx's own dispatch wrapper updates
      // `liveState` in the same tick), but the actual React unmount of ModelPicker and mount of
      // InputBox — which is what moves the NEXT keystroke's own useInput listener from one
      // component to the other — commits on a later tick. Measured on a real pty without this
      // wait: "a second task" arrived before that commit and landed in ModelPicker's still-
      // mounted filter query instead, rendered as "70b-versatile\ra second task" inside the
      // picker's own box, with no second RUNLOOP_CALL at all.
      await new Promise((resolve) => setTimeout(resolve, 100));

      child.stdin?.write("a second task");
      await sawLine("a second task");
      child.stdin?.write("\r");

      // A different model id, and 3 messages (1 initial + 1 turn-1 assistant reply + 1 new user
      // message) — the switch changed WHICH model answers, not what it was handed. The trailing
      // systemHasModelId=true proves the system prompt sent for THIS call names the NEW model
      // (llama-3.3-70b-versatile) — not the one the session started on — i.e. the identity line is
      // recomputed every driveLoop call rather than captured once at session start.
      await sawLine(
        "RUNLOOP_CALL 2 model=llama-3.3-70b-versatile messages=3 systemHasModelId=true",
      );

      // Scenarios a + e (feature-plan.md): the switch that just worked is now the global default
      // for every future brand-new session, not just this one — proven here on the write side.
      // Waiting for turn 2's own "done" first: it is only dispatched after turn 2's
      // messages-updated has already been processed by cli.ts's onEvent, which is where the
      // persist (if any) happens, so by the time "done" appears the write is already on disk.
      await sawLineTimes("(done: no-tool-call)", 2);
      const config = JSON.parse(readFileSync(join(dir, ".seri", "config.json"), "utf8"));
      expect(config.SERI_MODEL).toBe("llama-3.3-70b-versatile");
      expect(config.SERI_PROVIDER).toBe("groq");
      // Negative control built in: the pre-switch model must not be the one that landed.
      expect(config.SERI_MODEL).not.toBe("openai/gpt-oss-120b");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // D1/D2 (feature-plan.md): plan Test-plan item 8, "/model multi-route" — filtering to a model
  // reachable through more than one provider shows every route, and picking one specific route
  // (not just "a model") is what actually dispatches AND persists.
  test("/model shows every route to a multi-route model, and picking one persists that specific provider", async () => {
    const scriptPath = join(dir, "child-model-multiroute.mjs");
    writeFileSync(scriptPath, childScriptModelMultiRoute(dir));

    const { child, sawLine, sawLineTimes } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_CALL 1 model=openai/gpt-oss-120b provider=groq");
      await sawLine("(done: no-tool-call)");

      child.stdin?.write("/model");
      await sawLine("/model");
      child.stdin?.write("\r");
      // The Route column header — present regardless of catalog ordering, unlike a specific row.
      await sawLine("Route");

      // Narrows to exactly the two claude-sonnet-5 routes in the bundled manifest (verified
      // directly against catalog-manifest.json before writing this string): the native Anthropic
      // entry (bare id "claude-sonnet-5") and the OpenRouter entry ("anthropic/claude-sonnet-5",
      // which also contains this substring).
      child.stdin?.write("claude-sonnet-5");
      await sawLine("claude-sonnet-5");
      // Both routes visible — the actual proof decideModelPickerOpen's own unit tests can't give:
      // a real picker, on a real pty, showing both rows for one filtered query.
      await sawLine("anthropic");
      await sawLine("openrouter");

      // byRoutePriority (D2) sorts native before aggregator WITHIN a route group, so the
      // Anthropic row is already the top/default-selected one for this filtered query — no Down
      // press is needed to reach it. (The plan's own Test-plan item 8 says "Down to the anthropic
      // row," written before the picker's final ordering rule existed; selecting the
      // already-highlighted row via Enter directly is the accurate description of this picker's
      // real behavior, not a weaker test.)
      child.stdin?.write("\r");
      // The mandatory wait after any keypress that swaps the mounted component (picker -> input
      // box) — childScriptModelSwitch's own test has the full measured story for this.
      await new Promise((resolve) => setTimeout(resolve, 100));

      child.stdin?.write("a second task");
      await sawLine("a second task");
      child.stdin?.write("\r");

      await sawLine("RUNLOOP_CALL 2 model=claude-sonnet-5 provider=anthropic");
      await sawLineTimes("(done: no-tool-call)", 2);

      const config = JSON.parse(readFileSync(join(dir, ".seri", "config.json"), "utf8"));
      expect(config.SERI_MODEL).toBe("claude-sonnet-5");
      expect(config.SERI_PROVIDER).toBe("anthropic");
      // Negative control: the OTHER route to the same model must not be what persisted.
      expect(config.SERI_PROVIDER).not.toBe("openrouter");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // MEDIUM finding (code-review on PR #71): `confirmedModel` used to move to the new pair BEFORE
  // `persistDefaultModel` was even attempted, so a transient write failure (EACCES/ENOSPC/a
  // read-only config dir) left the inequality guard already satisfied and the write was never
  // retried, even though every later turn kept succeeding on the exact same model. Reuses
  // childScriptModelSwitch as-is (its fake runLoop already handles an arbitrary number of turns
  // generically) — the difference is entirely on the host side: the SECOND turn's persist attempt
  // is sabotaged, then cleared, and a THIRD turn on the same (already-switched) model proves the
  // retry.
  test("a failed default-model persist is retried by a later turn on the same model", async () => {
    const scriptPath = join(dir, "child-model-switch-persist-retry.mjs");
    writeFileSync(scriptPath, childScriptModelSwitch(dir));

    const { child, sawLine, sawLineTimes } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_CALL 1 model=openai/gpt-oss-120b messages=1 systemHasModelId=true");
      await sawLine("(done: no-tool-call)");

      // Sabotage the NEXT persist attempt before it happens: config/config.ts's own
      // write-then-rename path (writeConfig) writes to `<config.json>.tmp` before renaming it
      // into place — pre-creating that exact path AS A DIRECTORY makes its writeFileSync throw
      // EISDIR, the same class of failure a read-only config dir or a full disk would produce.
      const configDir = join(dir, ".seri");
      mkdirSync(configDir, { recursive: true });
      mkdirSync(join(configDir, "config.json.tmp"));

      child.stdin?.write("/model");
      await sawLine("/model");
      child.stdin?.write("\r");
      await sawLine("GPT OSS 120B");

      child.stdin?.write("70b-versatile");
      await sawLine("70b-versatile");
      child.stdin?.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 100));

      child.stdin?.write("a second task");
      await sawLine("a second task");
      child.stdin?.write("\r");

      // The switch DID take effect live, and the turn itself succeeded — this failure is
      // entirely in the persist attempt behind it, not in the model call.
      await sawLine(
        "RUNLOOP_CALL 2 model=llama-3.3-70b-versatile messages=3 systemHasModelId=true",
      );
      await sawLine("could not save the default model:");
      expect(existsSync(join(configDir, "config.json"))).toBe(false);

      // Clear the sabotage and let the SAME model answer one more turn — the retry this test
      // exists to prove, not a fresh switch.
      rmSync(join(configDir, "config.json.tmp"), { recursive: true, force: true });

      child.stdin?.write("a third task");
      await sawLine("a third task");
      child.stdin?.write("\r");

      await sawLine(
        "RUNLOOP_CALL 3 model=llama-3.3-70b-versatile messages=5 systemHasModelId=true",
      );
      await sawLineTimes("(done: no-tool-call)", 3);
      const config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
      expect(config.SERI_MODEL).toBe("llama-3.3-70b-versatile");
      expect(config.SERI_PROVIDER).toBe("groq");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // MEDIUM finding (code-review re-review on PR #71, on the retry test above): a PERSISTENTLY
  // failing persist — as opposed to the one-off transient blip the retry test above proves gets
  // retried on a LATER turn — must not re-attempt on every `messages-updated` WITHIN one turn.
  // childScriptModelSwitchMultiToolCall's own turn 2 yields it three times before `done`,
  // simulating three tool calls in one turn; the sabotage here is never cleared, so every one of
  // those three attempts would fail if this test's whole point weren't that only the FIRST one is
  // even attempted.
  test("a persistently failing persist is attempted once per turn, not once per tool call", async () => {
    const scriptPath = join(dir, "child-model-switch-multi-tool-call.mjs");
    writeFileSync(scriptPath, childScriptModelSwitchMultiToolCall(dir));

    const { child, sawLine, sawLineTimes, occurrences } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_CALL 1 model=openai/gpt-oss-120b");
      await sawLine("(done: no-tool-call)");

      // Sabotaged for the rest of this run — never cleared, unlike the retry test above, since
      // this test is about how many times ONE turn attempts against a failure that never clears.
      const configDir = join(dir, ".seri");
      mkdirSync(configDir, { recursive: true });
      mkdirSync(join(configDir, "config.json.tmp"));

      child.stdin?.write("/model");
      await sawLine("/model");
      child.stdin?.write("\r");
      await sawLine("GPT OSS 120B");

      child.stdin?.write("70b-versatile");
      await sawLine("70b-versatile");
      child.stdin?.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 100));

      child.stdin?.write("a second task");
      await sawLine("a second task");
      child.stdin?.write("\r");

      await sawLine("RUNLOOP_CALL 2 model=llama-3.3-70b-versatile");
      // Waiting for turn 2's own "done" (the second occurrence) is what guarantees all three of
      // its messages-updated events — and therefore every persist attempt they could have
      // triggered — have already been processed: "done" is only yielded, and only dispatched,
      // after the generator's three earlier yields have all been consumed in order.
      await sawLineTimes("(done: no-tool-call)", 2);

      // The actual assertion: one warning for the whole turn, not three.
      expect(occurrences("could not save the default model:")).toBe(1);
      expect(existsSync(join(configDir, "config.json"))).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // B2/MEDIUM-5: the other half of "context preserved" — a switch whose first turn FAILS must not
  // be the one that reaches disk. Same real picker interaction as the test above; the difference is
  // entirely in the fake runLoop (childScriptModelSwitchFailure's own comment).
  test("a /model switch whose first turn fails is not persisted — the on-disk session keeps the model that last worked", async () => {
    const scriptPath = join(dir, "child-model-switch-failure.mjs");
    writeFileSync(scriptPath, childScriptModelSwitchFailure(dir));

    const { child, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_CALL 1 model=openai/gpt-oss-120b");
      await sawLine("(done: no-tool-call)");

      child.stdin?.write("/model");
      await sawLine("/model");
      child.stdin?.write("\r");
      await sawLine("GPT OSS 120B");

      child.stdin?.write("70b-versatile");
      await sawLine("70b-versatile");
      child.stdin?.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 100));

      child.stdin?.write("a second task");
      await sawLine("a second task");
      child.stdin?.write("\r");

      // The switch DID take effect live — the second call was actually attempted against the new
      // model, same as the successful-switch test above — and it failed.
      await sawLine("RUNLOOP_CALL 2 model=llama-3.3-70b-versatile");
      // But the file on disk still names the model turn 1 actually completed with, not the one
      // turn 2 merely attempted and failed on.
      await sawLine("MODEL_ON_DISK_AFTER_FAILURE openai/gpt-oss-120b");

      // Scenario d (feature-plan.md): the failed pick must not become the global default either.
      // Turn 2 never emitted messages-updated at all (it failed straight to `error`), so cli.ts's
      // persist call — gated on messages-updated — never ran for this switch; turn 1 didn't
      // trigger it either, since it ran on the model the session already started on (no switch
      // yet, so the inequality guard never fires). config.json is never written by this run at all.
      expect(existsSync(join(dir, ".seri", "config.json"))).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // H-4 (the fatal path M-2's terminal-state fix guards): a second Ctrl-C, once the first has
  // already spent signals.ts's one cancel slot, is fatal rather than a second cancel — the same
  // "one slot, second press finds it empty" mechanism as everywhere else in this repo (see
  // signals.ts's own deliverSignal comment), reached here via App.tsx's onCancel instead of a
  // readline Interface. Asserted the same way tests/signals.test.ts's own "a second press skips
  // the unwind and still exits by signal" test is: the process actually terminates rather than
  // hanging, which is what M-2's onSignalCleanup(() => instance.unmount()) exists to make happen
  // cleanly (restoring raw mode) rather than leaving the terminal in whatever state a bare
  // process.kill mid-render left it in — not independently checkable from outside the dying
  // process on this pty harness, so this is the process-terminates half of that fix; the
  // terminal's own visual state is Phase 7's to confirm on a real terminal.
  test("a second Ctrl-C after the first is spent terminates the process instead of hanging", async () => {
    const scriptPath = join(dir, "child-cancel.mjs");
    writeFileSync(scriptPath, childScriptCancel(dir));

    const { child, exited, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      child.stdin?.write("\x03");
      await sawLine("RUNLOOP_ABORTED aborted=true");
      // The first press's cancel slot is now spent, and nothing re-registers one between turns
      // (runTui does not call driveLoop again until another task is submitted) — so this second
      // press finds the slot empty and falls straight through to signals.ts's fatal path.
      child.stdin?.write("\x03");

      const settled = await Promise.race([
        exited,
        new Promise<"the run never settled">((r) =>
          setTimeout(() => r("the run never settled"), 15_000),
        ),
      ]);

      expect(settled).not.toBe("the run never settled");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // HIGH-1: before this fix, runTui's own promise only ever rejected — a turn finishing normally
  // left `run()`'s `await runTui(...)` parked forever, so printUsage/the exit-code logic were dead
  // code on the TUI path. /exit is the new graceful-quit affordance: submitted once the turn is
  // done (turnInFlight has cleared), it should unmount Ink, resolve run() with a real exit code
  // (0, since doneReason is "no-tool-call" and nothing was refused), and print the same
  // token/cost summary line the non-interactive path prints via printUsage.
  test("submitting /exit after a turn completes resolves run() with a normal exit code and a final usage summary", async () => {
    const scriptPath = join(dir, "child-quit.mjs");
    writeFileSync(scriptPath, childScriptQuit(dir));

    const { child, exited, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      await sawLine("(done: no-tool-call)");

      child.stdin?.write("/exit");
      await sawLine("/exit");
      child.stdin?.write("\r");

      const result = await Promise.race([
        exited,
        new Promise<"the run never settled">((r) =>
          setTimeout(() => r("the run never settled"), 15_000),
        ),
      ]);

      expect(result).not.toBe("the run never settled");
      // Asserted on stdout's own EXIT_CODE line, not `result.code` — same reason
      // tests/cli/approvalPromptPty.test.ts's own comment gives: the pty allocator (python3)
      // reports its own exit status, not the grandchild bun process's, so `result.code` is
      // always 0 regardless of what run() actually returned.
      const { stdout } = result as Exit;
      expect(stdout).toContain("EXIT_CODE 0");
      // printUsage's own line shape (cli/output.ts) — proof it actually ran, not just that the
      // process happened to exit 0 some other way.
      expect(stdout).toContain("(tokens: 12 in, 34 out)");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // MEDIUM-C: Ctrl-D's own trigger for the same quit path /exit uses — a clone of the test above
  // with \x04 (Ctrl-D) in place of typing "/exit" and pressing Enter.
  test("Ctrl-D at the input box quits the same way /exit does", async () => {
    const scriptPath = join(dir, "child-quit-ctrld.mjs");
    writeFileSync(scriptPath, childScriptQuit(dir));

    const { child, exited, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      await sawLine("(done: no-tool-call)");

      child.stdin?.write("\x04");

      const result = await Promise.race([
        exited,
        new Promise<"the run never settled">((r) =>
          setTimeout(() => r("the run never settled"), 15_000),
        ),
      ]);

      expect(result).not.toBe("the run never settled");
      // Asserted on stdout's own EXIT_CODE line — childScriptQuit's own sibling test above
      // explains why `result.code` itself is not the right thing to check here.
      const { stdout } = result as Exit;
      expect(stdout).toContain("EXIT_CODE 0");
      expect(stdout).toContain("(tokens: 12 in, 34 out)");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // HIGH-B: /exit while a turn is in flight used to abandon it outright — controller.abort() was
  // never called, the turn's own usage was never folded into the final summary, and runTui's
  // promise never resolved at all (turnInFlight only clears in runTurn's own finally, which
  // abandoning the turn never triggered), so run() hung forever instead of settling. Mutation-
  // tested against the pre-fix quit() (no turnInFlight check at all): this test hung on the
  // RUNLOOP_ABORTED wait below until its own 60s timeout, every time — confirmed red before this
  // fix, confirmed green after.
  test("submitting /exit while a turn is in flight cancels it gracefully instead of abandoning it (HIGH-B)", async () => {
    const scriptPath = join(dir, "child-quit-mid-turn.mjs");
    writeFileSync(scriptPath, childScriptQuitMidTurn(dir));

    const { child, exited, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");

      child.stdin?.write("/exit");
      await sawLine("/exit");
      child.stdin?.write("\r");

      // MEDIUM-5: visible feedback that quitting is actually doing something, not a TUI that
      // looks frozen while the cancelled turn unwinds.
      await sawLine("quitting — cancelling the in-flight turn, Ctrl-C to force");

      // The discriminating assertion: pre-fix, quit() never touched turnInFlight or
      // cancellation, so controller.abort() was never called, the fake runLoop's own abort
      // listener never fired, and this line never appeared.
      await sawLine("RUNLOOP_ABORTED aborted=true");

      const result = await Promise.race([
        exited,
        new Promise<"the run never settled">((r) =>
          setTimeout(() => r("the run never settled"), 15_000),
        ),
      ]);

      expect(result).not.toBe("the run never settled");
      // Asserted on stdout's own EXIT_CODE line — childScriptQuit's own sibling test explains why
      // `result.code` itself is not the right thing to check here. The turn was cancelled, not
      // completed — doneReason is "aborted", which resolves to exit 1, the same code every other
      // *unaccomplished* run returns (`max-iterations`, `repeated-denials`) — NOT the signal-death
      // every other abort path in this codebase uses; a deliberate quit is not the fatal-signal
      // case `raiseSignal` exists for (cli.ts's own comment on this same fact, quit()'s own
      // comment). `seri "…" && next` must not run `next` off the back of a task /exit cut short
      // either way, so this is 1, not the clean-quit test's own 0.
      const { stdout } = result as Exit;
      expect(stdout).toContain("EXIT_CODE 1");
      // The turn's own usage (spent before it was cancelled) still made it into the final
      // summary — proof runTurn's usage-folding ran (and quit() waited for it) before resolving,
      // not that the process just happened to exit some other way.
      expect(stdout).toContain("(tokens: 12 in, 34 out)");

      // LOW-1: a mid-turn /exit leaves the session resumable — a well-formed session file still
      // on disk, not corrupted or removed by the cancel-then-quit sequence.
      const sessionsDir = join(dir, "sessions");
      const sessionFile = readdirSync(sessionsDir).find((f) => f.endsWith(".json"));
      if (sessionFile === undefined) throw new Error("no session file written");
      const onDisk = JSON.parse(readFileSync(join(sessionsDir, sessionFile), "utf8"));
      expect(onDisk.id).toBe(sessionFile.replace(/\.json$/, ""));
      expect(Array.isArray(onDisk.messages)).toBe(true);
      expect(onDisk.messages.length).toBeGreaterThan(0);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // MEDIUM-C: a second turn with its own usage — the final summary must sum both, not report only
  // the last turn's, which addTokens/runTui's own accumulation (cli.ts) claims but had no test.
  test("a multi-turn session's final usage summary sums every turn's tokens, not just the last one", async () => {
    const scriptPath = join(dir, "child-multi-turn-usage.mjs");
    writeFileSync(scriptPath, childScriptMultiTurnUsage(dir));

    const { child, exited, sawLine, sawLineTimes } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_CALL 1");
      await sawLine("(done: no-tool-call)");

      child.stdin?.write("a second task");
      await sawLine("a second task");
      child.stdin?.write("\r");
      await sawLine("RUNLOOP_CALL 2");
      // The SECOND occurrence specifically — the plain sawLine above is already true from turn
      // 1's own, and sending /exit before turn 2's driveLoop call has actually returned would
      // race turnInFlight instead of testing what this test is about.
      await sawLineTimes("(done: no-tool-call)", 2);

      child.stdin?.write("/exit");
      await sawLine("/exit");
      child.stdin?.write("\r");

      const result = await Promise.race([
        exited,
        new Promise<"the run never settled">((r) =>
          setTimeout(() => r("the run never settled"), 15_000),
        ),
      ]);

      expect(result).not.toBe("the run never settled");
      // Asserted on stdout's own EXIT_CODE line — childScriptQuit's own sibling test explains why
      // `result.code` itself is not the right thing to check here.
      const { stdout } = result as Exit;
      expect(stdout).toContain("EXIT_CODE 0");
      // Turn 1: 10 in, 20 out. Turn 2: 20 in, 40 out. Summed: 30 in, 60 out — not turn 2's own
      // 20/40 alone.
      expect(stdout).toContain("(tokens: 30 in, 60 out)");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // MEDIUM-3: /undo, /restore and /rewind are gated while a turn is in flight (a mid-turn
  // /rewind would truncate session.messages only for the still-running turn's own next
  // messages-updated to replace the whole array wholesale, erasing the truncation) — /mode is
  // deliberately NOT gated, and this test confirms that difference rather than just the block.
  test("/rewind is blocked while a turn is in flight, but /mode still works (MEDIUM-3)", async () => {
    const scriptPath = join(dir, "child-turn-in-flight-gate.mjs");
    writeFileSync(scriptPath, childScriptInput(dir));

    const { child, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");

      child.stdin?.write("/rewind 1");
      await sawLine("/rewind 1");
      child.stdin?.write("\r");
      await sawLine("/rewind: can't run while a turn is in flight.");

      // Still alive, and /mode (deliberately ungated) still works — proof the block above is
      // specific to /rewind, not the input box wedged or the whole command path broken.
      child.stdin?.write("/mode");
      await sawLine("/mode");
      child.stdin?.write("\r");
      await sawLine("permission mode is now auto");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // Design-question fix (this PR's own follow-up): a submission rejected by the turnInFlight gate
  // (same /rewind-while-in-flight gate as the test just above) still gets echoed, per this whole
  // PR's own point — but the echo must not fragment the model's still-streaming answer into two
  // transcript entries via transcript-append's own default flush behavior. "Hello " streams, /rewind
  // 1 is sent and rejected while that is still pending, then "world" streams and the turn finishes
  // — end-to-end proof (not just the reducer-unit level) that the full answer lands as ONE
  // contiguous transcript entry, "Hello world", not split around the rejected command's own echo.
  test("a submission rejected by the turnInFlight gate is echoed without fragmenting the model's in-progress answer", async () => {
    const flagPath = join(dir, "release-turn");
    const scriptPath = join(dir, "child-rewind-during-stream.mjs");
    writeFileSync(scriptPath, childScriptRewindDuringStream(dir, flagPath));

    const { child, sawLine, occurrences } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      await sawLine("STREAM_PART_1");

      child.stdin?.write("/rewind 1");
      await sawLine("/rewind 1");
      child.stdin?.write("\r");
      await sawLine("/rewind: can't run while a turn is in flight.");

      writeFileSync(flagPath, "");
      await sawLine("(done: no-tool-call)");

      expect(occurrences("Hello world")).toBe(1);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // LOW-4/MEDIUM-1: the disk-level regression test that should have existed to catch MEDIUM-1 in
  // the first place — the existing reducer-unit test only checks in-memory state, which the old,
  // buggy code also got right eventually; the bug was specifically about what landed on disk in
  // between. Asserts the on-disk session file directly, not the transcript or reducer state.
  test("a mid-turn /mode change is on disk before the turn's next write, and that write does not revert it", async () => {
    const flagPath = join(dir, "release-turn");
    const scriptPath = join(dir, "child-mode-persist.mjs");
    writeFileSync(scriptPath, childScriptModePersistence(dir, flagPath));
    const sessionsDir = join(dir, "sessions");

    const { child, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      await sawLine("RUNLOOP_MSG1");

      child.stdin?.write("/mode");
      await sawLine("/mode");
      child.stdin?.write("\r");
      await sawLine("permission mode is now auto");

      const sessionFile = readdirSync(sessionsDir).find((f) => f.endsWith(".json"));
      if (sessionFile === undefined) throw new Error("no session file written yet");
      const sessionPath = join(sessionsDir, sessionFile);

      // Polled, not asserted immediately: the write happens in App.tsx's own onSessionChange
      // effect, which fires after the dispatch above, not synchronously with the keypress.
      const deadline = Date.now() + 5_000;
      let mode: string;
      do {
        mode = JSON.parse(readFileSync(sessionPath, "utf8")).permissionMode;
      } while (mode !== "auto" && Date.now() < deadline);
      expect(mode).toBe("auto");

      // Release the still-in-flight turn's second messages-updated. Pre-MEDIUM-1-fix, driveLoop's
      // own direct saveSession call here used the turn-start (pre-/mode) session and clobbered
      // the file above back to "approve-each" — for the narrow window before the reducer's own
      // effect corrected it again. HIGH-A: the child script's own MODE_AT_RESUME marker (its own
      // comment explains why) is what actually observes that window; waiting for a later line in
      // the transcript, like the old version of this test did, does not.
      writeFileSync(flagPath, "");
      await sawLine("MODE_AT_RESUME auto");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // Round 8 code review, finding 1: onSessionChange (cli.ts) used to call saveSession bare, with
  // nothing to catch a throw. The sessions directory is replaced with a regular file AFTER
  // prepareSession's own initial save has already succeeded (mkdirSync's own `recursive: true`
  // then throws EEXIST on every later call, since the path exists but is not a directory) —
  // deterministic and cross-platform, unlike trying to fill a real disk. Mutation-tested live (WSL,
  // reverting onSessionChange to a bare `saveSession(session, ctx.sessionsDir)`): the throw did NOT
  // just hang silently — it escaped the React effect entirely and Ink's own renderer caught it and
  // dumped a raw `EEXIST: file already exists, mkdir '.../sessions'` stack trace across the whole
  // terminal (twice), which is worse than a bare hang, not better. Either way "could not save the
  // session" (this fix's own message) never appeared and the pending `/mode` never completed —
  // sawLine's own 20s deadline is what actually bounds that wait, not a separate race. Confirmed
  // green again with the fix restored.
  test("a session-save failure surfaces as a command error instead of hanging forever (finding 1)", async () => {
    const scriptPath = join(dir, "child-save-failure.mjs");
    writeFileSync(scriptPath, childScriptInput(dir));
    const sessionsDir = join(dir, "sessions");

    const { child, sawLine, sawLineTimes } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");

      // Sabotage AFTER the initial save succeeds — prepareSession's own unconditional saveSession
      // call, unrelated to the bug under test, must be given a real chance to land first.
      rmSync(sessionsDir, { recursive: true, force: true });
      writeFileSync(sessionsDir, "");

      child.stdin?.write("/mode");
      await sawLine("/mode");
      child.stdin?.write("\r");
      await sawLine("could not save the session");

      // Still alive, not wedged: restore a writable sessions dir and confirm a later command still
      // completes normally.
      rmSync(sessionsDir, { force: true });
      child.stdin?.write("/mode");
      await sawLineTimes("/mode", 2);
      child.stdin?.write("\r");
      await sawLine("permission mode is now");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // Pins the `interactive: true` fix on cli.ts's own render() call (its own comment there has the
  // full account) — without it, Ink's CI auto-detection (`is-in-ci`) treats a real pty as
  // non-interactive whenever `CI` is set, which is GitHub Actions' own default for every job, and
  // stops live-rendering regardless of `stdout.isTTY`. `CI=true` is set on the CHILD process only
  // (childScriptCiEnv's own first line) to reproduce that exact condition without needing real CI.
  test("the TUI still renders and responds to input when CI=true is set (the GitHub Actions default)", async () => {
    const scriptPath = join(dir, "child-ci-env.mjs");
    writeFileSync(scriptPath, childScriptCiEnv(dir));

    const { child, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");

      child.stdin?.write("/mode");
      await sawLine("/mode");
      child.stdin?.write("\r");
      await sawLine("permission mode is now auto");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // Findings 1+5: this is the test that would have caught finding 1 existing at all — a real
  // write-tool approval prompt, on a real pty, rendered by the TUI's own ApprovalBox and answered
  // by an actual keypress, confirming the turn unblocks. Before this fix, this same scenario
  // opened a SECOND readline.Interface on process.stdin underneath Ink's own raw-mode ownership —
  // this test does not directly assert that absence (there is nothing to observe about a
  // readline.Interface from outside the process), but it does prove the REPLACEMENT mechanism
  // (dispatch a pendingApproval, render it, answer it via Ink's own input, resolve the promise)
  // works end to end, which the old readline-based prompt never had a route to at all on this path.
  test("a write-tool approval prompt renders in the TUI and a keypress unblocks the turn", async () => {
    const scriptPath = join(dir, "child-approval.mjs");
    writeFileSync(scriptPath, childScriptApproval(dir));

    const { child, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      // The TUI's own ApprovalBox rendering the SAME prompt text makeApprovalPrompt uses — split
      // across two checks, not one long toContain, since Ink wraps this line across the box's own
      // bordered rows (measured, same as App.test.tsx's own version of this same assertion).
      await sawLine(`Approve write_file({"path":"a.txt","content":"hi"})? [y]es / [a]lways`);
      await sawLine("[N]o");

      child.stdin?.write("y");
      await sawLine("PROMPT_ANSWER once");

      // Still alive and the turn actually finished — proof the answer really unblocked
      // driveLoop's own await, not that the process just happened to still be running.
      await sawLine("(done: no-tool-call)");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // D2/D3 (feature-plan.md): the routing-priority reroute end to end — a real turn actually
  // dispatches to the rerouted provider's own constructor (`via=anthropic`, not the requested
  // `or`), and the transcript carries exactly the notice D2 requires.
  //
  // Does NOT assert a config.json write. D3's own fix — confirmedModel/lastPersistedModel
  // initialize from `prepared.route` (the pair prepareSession already resolved), not
  // `prepared.session` (what was merely requested) — means a session whose reroute is already
  // active BEFORE its first turn even runs looks, to the persist guard, identical to a session
  // that never touched /model at all: turn 1's own re-resolution lands on the SAME pair the guard
  // already started at, so the inequality never trips and nothing new is written. This is
  // deliberate, not an oversight: pinning an automatic fallback to the GLOBAL default the instant
  // it happens once would mean a transient missing key permanently changes what every future
  // brand-new session uses, even after the key is added back — the tripwire this protects
  // (tuiPty.test.ts's own "never touched /model never writes config.json" test) applies with equal
  // force to "never touched /model, only got auto-rerouted." A LIVE /model pick that itself then
  // gets rerouted (D4's own scenario) is a genuine mid-session CHANGE and persists normally — that
  // path is exercised by childScriptModelSwitch's own suite of tests already, unmodified by this
  // loop.
  test("a routing-priority reroute active from session start takes effect on turn 1 and announces itself once, without touching config.json", async () => {
    const scriptPath = join(dir, "child-reroute.mjs");
    writeFileSync(scriptPath, childScriptReroute(dir));

    const { child, sawLine, occurrences } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_CALL 1 via=anthropic provider=anthropic");
      // Split across two checks, not one long toContain/sawLine: measured on a real pty (WSL),
      // Ink wraps this line across the terminal's own column width, landing "configured" on its
      // own following line — the same wrapping App.test.tsx's own approval-prompt assertion
      // already works around.
      const noticePrefix =
        "↻ routing claude-sonnet-5 via anthropic (your key) — no OPENROUTER_API_KEY";
      await sawLine(noticePrefix);
      await sawLine("configured");
      await sawLine("(done: no-tool-call)");

      // Exactly one transcript notice for this one turn — the per-turn cap D2's own acceptance
      // criterion names, not a re-print on every messages-updated event within it.
      expect(occurrences(noticePrefix)).toBe(1);

      // The negative control this test's own point rests on: verified by first removing D3's own
      // fix (initializing confirmedModel/lastPersistedModel from `prepared.session` instead of
      // `prepared.route`) and re-running this exact assertion — it failed, with config.json
      // present and SERI_PROVIDER: "anthropic" written on turn 1, confirming the assertion below
      // actually exercises the fix rather than being vacuously true.
      expect(existsSync(join(dir, ".seri", "config.json"))).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // The negative-control sibling of the test above: an explicit pick whose own provider HAS a key
  // wins even when a native sibling also has one (D2 rule 1) — no reroute, and therefore no notice.
  test("an explicit pick with its own key stays on that provider and never prints a reroute notice", async () => {
    const scriptPath = join(dir, "child-no-reroute.mjs");
    writeFileSync(scriptPath, childScriptNoReroute(dir));

    const { child, sawLine, occurrences } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_CALL 1 via=or provider=openrouter");
      await sawLine("(done: no-tool-call)");

      expect(occurrences("↻ routing")).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // D5-D8 (feature-plan.md): /setup end to end on a real pty. `wait()` is the mandatory 100ms
  // pause this file's own /model tests already require after any keypress that swaps InputBox for
  // a different mounted component (or back) — React's own unmount/mount commits a tick after the
  // dispatch that triggered it (childScriptModelSwitch's own test has the full measured story);
  // omitting it here would be the identical bug, just for /setup's own panel instead of the picker.
  function seedConfig(target: string, values: Record<string, string>): void {
    const configDir = join(target, ".seri");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify(values));
  }

  function wait100ms(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 100));
  }

  describe("/setup", () => {
    test("lists all five providers with correct source, masked values, and disabled removal for an env row", async () => {
      seedConfig(dir, { ANTHROPIC_API_KEY: "sk-ant-fake-config-key-abcdefgh" });
      const scriptPath = join(dir, "child-setup-list.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine } = startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/setup");
        await sawLine("/setup");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("/setup — provider API keys");

        await sawLine("sk-a...efgh");
        await sawLine("set by $GROQ_API_KEY in your environment");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("add: a new key lands in config.json, and the raw value never appears in the pty stdout", async () => {
      const scriptPath = join(dir, "child-setup-add.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine, exited } = startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/setup");
        await sawLine("/setup");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("/setup — provider API keys");

        // CATALOG_PROVIDERS order is groq, openrouter, anthropic, openai, google — one Down
        // reaches openrouter, unset at this point (only GROQ_API_KEY is set, as an env var).
        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("a");
        await wait100ms();
        await sawLine("OPENROUTER_API_KEY for openrouter");

        const secret = "sk-or-added-secret-key";
        child.stdin?.write(secret);
        await wait100ms();
        child.stdin?.write("\r");
        await sawLine("Saved OPENROUTER_API_KEY.");

        const config = JSON.parse(readFileSync(join(dir, ".seri", "config.json"), "utf8"));
        expect(config.OPENROUTER_API_KEY).toBe(secret);

        // The negative control at the process level: the raw key must never have reached stdout,
        // masked or otherwise — checked against the WHOLE accumulated transcript, not just the
        // enter-key step's own frame.
        child.kill("SIGKILL");
        const { stdout } = await exited;
        expect(stdout).not.toContain(secret);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("replace: a different value overwrites the existing one, and no other key is touched", async () => {
      seedConfig(dir, {
        OPENROUTER_API_KEY: "sk-or-original-value",
        ANTHROPIC_API_KEY: "sk-ant-untouched-value",
      });
      const scriptPath = join(dir, "child-setup-replace.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine } = startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/setup");
        await sawLine("/setup");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("/setup — provider API keys");

        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("a");
        await wait100ms();
        await sawLine("OPENROUTER_API_KEY for openrouter");

        child.stdin?.write("sk-or-replaced-value");
        await wait100ms();
        child.stdin?.write("\r");
        await sawLine("Saved OPENROUTER_API_KEY.");

        const config = JSON.parse(readFileSync(join(dir, ".seri", "config.json"), "utf8"));
        expect(config.OPENROUTER_API_KEY).toBe("sk-or-replaced-value");
        expect(config.ANTHROPIC_API_KEY).toBe("sk-ant-untouched-value");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("remove: the confirmed key is gone, and the other survives", async () => {
      seedConfig(dir, {
        OPENROUTER_API_KEY: "sk-or-to-remove",
        ANTHROPIC_API_KEY: "sk-ant-to-keep",
      });
      const scriptPath = join(dir, "child-setup-remove.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine } = startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/setup");
        await sawLine("/setup");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("/setup — provider API keys");

        // openrouter (index 1) is config-sourced here, so removable.
        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("r");
        await wait100ms();
        await sawLine("Remove OPENROUTER_API_KEY");

        child.stdin?.write("y");
        await sawLine("Removed OPENROUTER_API_KEY.");

        const config = JSON.parse(readFileSync(join(dir, ".seri", "config.json"), "utf8"));
        expect(config.OPENROUTER_API_KEY).toBeUndefined();
        expect(config.ANTHROPIC_API_KEY).toBe("sk-ant-to-keep");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    // The negative control opening the panel alone (and closing it again) must not write anything.
    test("cancel: opening and closing /setup with Escape writes nothing", async () => {
      const scriptPath = join(dir, "child-setup-cancel.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine } = startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/setup");
        await sawLine("/setup");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("/setup — provider API keys");

        child.stdin?.write("\x1b"); // Escape
        await new Promise((resolve) => setTimeout(resolve, 30)); // Escape's own ambiguity window
        await wait100ms();

        expect(existsSync(join(dir, ".seri", "config.json"))).toBe(false);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("/setup with an argument is rejected and opens no panel", async () => {
      const scriptPath = join(dir, "child-setup-bad-args.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine, occurrences } = startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/setup now");
        await sawLine("/setup now");
        child.stdin?.write("\r");
        await sawLine("/setup: invalid arguments.");

        expect(occurrences("/setup — provider API keys")).toBe(0);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    // D8: an env-sourced row reports the environment as its source and refuses removal, even
    // though a DIFFERENT value for the same key also sits in config.json underneath it.
    test("an env-shadowed row reports the environment as the source and refuses removal", async () => {
      seedConfig(dir, { OPENAI_API_KEY: "sk-openai-config-value-should-not-be-used" });
      const scriptPath = join(dir, "child-setup-env-shadow.mjs");
      writeFileSync(scriptPath, childScriptSetupEnvShadow(dir));

      const { child, sawLine, occurrences } = startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/setup");
        await sawLine("/setup");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("/setup — provider API keys");
        await sawLine("set by $OPENAI_API_KEY in your environment");

        // Down to openrouter, anthropic, openai — three Downs (groq=0, openrouter=1,
        // anthropic=2, openai=3).
        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("r");
        await wait100ms();

        // Refused — removable is false for an env row, so the confirm-remove step never even
        // opens: no "Remove OPENAI_API_KEY" prompt anywhere in the transcript, and config.json
        // (still holding the ORIGINAL, shadowed value) is untouched.
        expect(occurrences("Remove OPENAI_API_KEY")).toBe(0);
        const config = JSON.parse(readFileSync(join(dir, ".seri", "config.json"), "utf8"));
        expect(config.OPENAI_API_KEY).toBe("sk-openai-config-value-should-not-be-used");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);
  });
});
