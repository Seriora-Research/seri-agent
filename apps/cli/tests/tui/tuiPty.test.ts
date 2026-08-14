import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
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

// D4's own real surviving code path (feature-plan.md): D3's fix makes it structurally impossible
// for a session that starts already-rerouted to ever persist on turn 1 (see childScriptReroute's
// own test, above) — so the only place D4 ("persist the RESOLVED pair, not the one requested") can
// still fire is a LIVE, mid-session /model pick whose own target then gets rerouted on the very
// next turn. Turn 1 runs on the session's own starting pair (GROQ_API_KEY configured, no reroute).
// Mid-session, the picker explicitly selects (claude-sonnet-5, openrouter) — OPENROUTER_API_KEY is
// deliberately never set, and ANTHROPIC_API_KEY is, so resolveRoute reroutes turn 2 to the native
// sibling instead.
function childScriptModelPickRerouted(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `process.env.ANTHROPIC_API_KEY = "fake-test-key";`,
    `delete process.env.OPENROUTER_API_KEY;`,
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

// Regression for a corrupted persisted pair: unlike childScriptModelMultiRoute, this deliberately
// does NOT inject getAnthropicModel — getModel's own real (uninjected) branch is what checks for
// an API key and throws, so picking the anthropic route with no ANTHROPIC_API_KEY set fails the
// turn before driveLoop is ever called (no messages-updated, so confirmedModel never advances).
function childScriptModelPickKeyless(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `delete process.env.ANTHROPIC_API_KEY;`,
    `delete process.env.OPENROUTER_API_KEY;`,
    `process.env.SERI_DISABLE_MODELS_FETCH = "1";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `let calls = 0;`,
    `async function* runLoopFake(opts) {`,
    `  calls++;`,
    `  console.log("\\nRUNLOOP_CALL " + calls + " model=" + opts.model.id);`,
    `  yield { type: "messages-updated", messages: [...opts.messages, { role: "assistant", content: "ok" }] };`,
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

// Stage C (cli-commands-to-tui feature-plan.md): /login, /signup and /logout's own script.
// `login`/`logout` are faked via the SAME injection seam `handleAuthCommand` already uses for the
// non-interactive `seri login`/`seri logout` (argv.test.ts's own "run (login/signup/logout)"
// describe block) — the fake stands in for the real WorkOS device flow the way every other
// runLoopFake in this file stands in for a real model round-trip, and calls the real
// saveAuthSession/loadAuthSession/clearAuthSession (dynamically imported below) so auth.json on
// disk is genuinely written/read/cleared, not merely asserted on captured stdout.
function childScriptAuth(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.SERI_DISABLE_MODELS_FETCH = "1";`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `const authStore = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "../../src/auth/authStore.ts")).href)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  await new Promise(() => {});`,
    `}`,
    // The negative control's own subject (below, host-side): must never reach stdout, masked or
    // otherwise — the same "the raw value never appears in the pty stdout" guarantee /setup's own
    // "add" pty test already holds itself to, applied to an access token instead of a provider key.
    `const FAKE_ACCESS_TOKEN = "fake-access-token-must-never-print";`,
    `async function loginFake(mode, clientId, configDir, handlerDeps) {`,
    `  handlerDeps?.onDeviceCode?.({`,
    `    verificationUri: "https://example.com/device",`,
    `    userCode: "ABCD-1234",`,
    `  });`,
    `  await new Promise((resolve) => setTimeout(resolve, 50));`,
    `  authStore.saveAuthSession(`,
    `    {`,
    `      accessToken: FAKE_ACCESS_TOKEN,`,
    `      refreshToken: "fake-refresh-token",`,
    `      userId: "user-1",`,
    `      email: "fake@example.com",`,
    `      obtainedAt: new Date().toISOString(),`,
    `    },`,
    `    configDir,`,
    `  );`,
    `  handlerDeps?.onMessage?.("Logged in as fake@example.com");`,
    `}`,
    `function logoutFake(configDir, onMessage) {`,
    `  const existing = authStore.loadAuthSession(configDir);`,
    `  authStore.clearAuthSession(configDir);`,
    `  (onMessage ?? console.log)(existing ? "Logged out." : "Not logged in.");`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  login: loginFake,`,
    `  logout: logoutFake,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

// Bug fix (coordinator follow-up on Stage C): the failure round-trip childScriptAuth's own
// describe block never exercised — `loginFake` here rejects the way the real device flow does on
// a denied/expired code, driving createAuthHandlers' own catch branch (cli.ts) in a real process,
// not just at the reducer level (App.test.tsx already covers that half).
function childScriptAuthLoginFails(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.SERI_DISABLE_MODELS_FETCH = "1";`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  await new Promise(() => {});`,
    `}`,
    `async function loginFake(mode, clientId, configDir, handlerDeps) {`,
    `  handlerDeps?.onDeviceCode?.({`,
    `    verificationUri: "https://example.com/device",`,
    `    userCode: "ABCD-1234",`,
    `  });`,
    `  await new Promise((resolve) => setTimeout(resolve, 50));`,
    `  throw new Error("Authorization was denied.");`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  login: loginFake,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

// Bug fix (thermo-nuclear + code-review, round 4): the real soft-lock this round closes — before
// it, nothing dismissed the "starting"/"device" steps at all, and Ctrl-C fell through to a hard
// process kill (no turn in flight to arm the cancel slot). `loginFake` here hangs indefinitely
// past the device-code callback (the same "never resolves" idiom `runLoopFake` itself already
// uses throughout this file), standing in for a real device code that stays valid for minutes
// with the user never completing it in a browser.
function childScriptAuthLoginHangs(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.SERI_DISABLE_MODELS_FETCH = "1";`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  await new Promise(() => {});`,
    `}`,
    `async function loginFake(mode, clientId, configDir, handlerDeps) {`,
    `  handlerDeps?.onDeviceCode?.({`,
    `    verificationUri: "https://example.com/device",`,
    `    userCode: "ABCD-1234",`,
    `  });`,
    `  await new Promise(() => {});`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  login: loginFake,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

// Bug fix (thermo-nuclear, round 5): unlike childScriptAuthLoginHangs (whose fake never resolves
// at all, so it can only prove Escape returns the UI — it can't distinguish "the poll was really
// cancelled" from "cancellation doesn't exist and we just stopped listening"), this fake's own
// poll resolves ~1s AFTER Escape, checking `handlerDeps.signal?.aborted` itself — the exact same
// AbortSignal `createAuthHandlers.onLogin` (cli.ts) threads through the real `loginFn`'s 4th
// argument. This is what proves the real plumbing: onAbandon's own `.abort()` call actually
// reaches this fake in time, not just that createAuthHandlers stopped honoring its dispatches.
function childScriptAuthLoginRace(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.SERI_DISABLE_MODELS_FETCH = "1";`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `const authStore = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "../../src/auth/authStore.ts")).href)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  await new Promise(() => {});`,
    `}`,
    `async function loginFake(mode, clientId, configDir, handlerDeps) {`,
    `  handlerDeps?.onDeviceCode?.({`,
    `    verificationUri: "https://example.com/device",`,
    `    userCode: "ABCD-1234",`,
    `  });`,
    `  await new Promise((resolve) => setTimeout(resolve, 1000));`,
    `  if (handlerDeps?.signal?.aborted) return;`,
    `  authStore.saveAuthSession(`,
    `    {`,
    `      accessToken: "fake-access-token-must-never-print",`,
    `      refreshToken: "fake-refresh-token",`,
    `      userId: "user-1",`,
    `      email: "fake@example.com",`,
    `      obtainedAt: new Date().toISOString(),`,
    `    },`,
    `    configDir,`,
    `  );`,
    `  handlerDeps?.onMessage?.("Logged in as fake@example.com");`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  login: loginFake,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

// byok-guided-setup, feature-plan.md: the "genuinely blank first run" scenario — a real TTY, no
// config.json (childScriptSetup's own dir is always fresh, but every OTHER script in this file
// still exports GROQ_API_KEY as a real env var; this one explicitly deletes every provider's own
// key, matching code-quality.md's "the platform matrix does not cover the unset case" guard, since
// the dev/CI box's own ambient env could otherwise mask run()'s new isTTY-and-zero-keys gate). No
// `getGroqModel` override, unlike every other script in this file: injecting one would bypass the
// REAL groq.ts's own `if (!apiKey) throw missingKeyError("groq")` — the exact throw prepareSession
// relies on today, pre-fix, to hard-exit before Ink ever mounts. The real getGroqModel only ever
// constructs an SDK client (`createGroq({ apiKey })(modelId)`, no network I/O at creation), so
// once /setup writes a fake GROQ_API_KEY, it resolves fine — the injected `runLoopFake` below never
// touches the model object either way.
function childScriptGuidedSetup(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.SERI_DISABLE_MODELS_FETCH = "1";`,
    `process.env.SERI_SKIP_KEY_VALIDATION = "1";`,
    `delete process.env.GROQ_API_KEY;`,
    `delete process.env.OPENROUTER_API_KEY;`,
    `delete process.env.ANTHROPIC_API_KEY;`,
    `delete process.env.OPENAI_API_KEY;`,
    `delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `const code = await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
    `console.log("\\nEXIT_CODE " + code);`,
  ].join("\n");
}

// Code-review finding, PR #91: unlike childScriptGuidedSetup, deliberately does NOT set
// SERI_DISABLE_MODELS_FETCH — that env var makes loadCatalog resolve synchronously (a cache hit
// against the bundled manifest), which would make this script incapable of ever observing the bug
// it exists to catch. `globalThis.fetch` is patched, BEFORE cli.ts is imported (so
// `getModelCatalog()`'s own `fetchFn: typeof fetch = fetch` default parameter — evaluated at call
// time, not at catalog.ts's own module-load time — picks up the patched version), to hang forever
// on the models.dev request specifically and pass every other URL through to the real fetch. NOT a
// blanket override (measured live): Ink's own yoga-layout dependency loads its WASM binary via a
// `fetch()` of a `data:` URI at import time, so a blanket-hung fetch made `await import("ink")`
// itself hang forever too — a false failure with nothing to do with the catalog fetch this script
// exists to simulate as offline.
function childScriptGuidedSetupSlowFetch(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.SERI_SKIP_KEY_VALIDATION = "1";`,
    `delete process.env.GROQ_API_KEY;`,
    `delete process.env.OPENROUTER_API_KEY;`,
    `delete process.env.ANTHROPIC_API_KEY;`,
    `delete process.env.OPENAI_API_KEY;`,
    `delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;`,
    // This suite's own npm script sets SERI_DISABLE_MODELS_FETCH=1 for the WHOLE `bun test`
    // process (apps/cli/package.json) — inherited by this spawned child unless deleted here, which
    // would make loadCatalog resolve synchronously and this test vacuous whenever it runs as part
    // of the full suite rather than in isolation (measured live: passed for the wrong reason).
    `delete process.env.SERI_DISABLE_MODELS_FETCH;`,
    `const realFetch = globalThis.fetch;`,
    `globalThis.fetch = (url, opts) =>`,
    `  typeof url === "string" && url.includes("models.dev")`,
    `    ? new Promise(() => {})`,
    `    : realFetch(url, opts);`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

// Code-review finding, PR #91 round 2: unlike childScriptGuidedSetupSlowFetch's own
// never-resolving fetch (which can only ever exercise the dead-input/re-entrancy half of the
// blocking bug, since a promise that never settles never reaches onSetupClose's own `.then`),
// this one resolves the models.dev request after a short, bounded delay — long enough to still be
// pending when a second key-add is started, short enough to keep the test itself fast. The 500
// status makes loadCatalog's own `!response.ok` branch throw and fall back to the bundled
// manifest, so no real models.dev response shape needs to be faked here.
function childScriptGuidedSetupDelayedFetch(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.SERI_SKIP_KEY_VALIDATION = "1";`,
    `delete process.env.GROQ_API_KEY;`,
    `delete process.env.OPENROUTER_API_KEY;`,
    `delete process.env.ANTHROPIC_API_KEY;`,
    `delete process.env.OPENAI_API_KEY;`,
    `delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;`,
    `delete process.env.SERI_DISABLE_MODELS_FETCH;`,
    `const realFetch = globalThis.fetch;`,
    `globalThis.fetch = (url, opts) =>`,
    `  typeof url === "string" && url.includes("models.dev")`,
    `    ? new Promise((resolve) =>`,
    `        setTimeout(() => resolve(new Response("", { status: 500 })), 3000),`,
    `      )`,
    `    : realFetch(url, opts);`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `const code = await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
    `console.log("\\nEXIT_CODE " + code);`,
  ].join("\n");
}

// cli-tui-stage-b-bare-seri, feature-plan.md Stage B: a real TTY, no positionals, no --continue/
// --resume — the exact case that used to hard-exit with USAGE before this stage and now mounts the
// TUI idle instead. GROQ_API_KEY is set (unlike childScriptGuidedSetup) so the zero-keys gate never
// fires and the only thing under test is bare seri's own idle-mount/no-auto-start behavior, not the
// gate composition (already covered by the guided-setup describe block above).
function childScriptBare(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.SERI_DISABLE_MODELS_FETCH = "1";`,
    `process.env.SERI_SKIP_KEY_VALIDATION = "1";`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `const code = await cli.run([], {`,
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

// Stage E (cli-commands-to-tui feature-plan.md): --max-turns 5 as the startup default, bare-mount
// idle (like childScriptBare, above) so a command can be typed BEFORE any task is submitted. The
// fake runLoop reports opts.maxIterations, the same "have the fake loop print the field under
// test" convention childScriptModelSwitch's own runLoopFake uses for opts.model/opts.provider —
// so a live /max-turns override (typed before the task) can be proven to reach the very next
// driveLoop call, with no restart.
function childScriptMaxTurns(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.SERI_DISABLE_MODELS_FETCH = "1";`,
    `process.env.SERI_SKIP_KEY_VALIDATION = "1";`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_MAXITERATIONS " + opts.maxIterations);`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `const code = await cli.run(["--max-turns", "5"], {`,
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

// Stage E's own /profile new end-to-end proof reuses childScriptBare directly (code-review round
// 2: the two were byte-for-byte identical function bodies under a different name — a bare-mount
// idle TUI is exactly what /profile new's own test needs too, since HOME redirection is already
// childScriptBare's job, and decideProfileCreate's getBaseConfigDir() reads that same HOME).

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

  // Polls for config.json to satisfy a predicate on its own PARSED content, rather than a flat
  // sleep or a bare existence check — measured live (a session-start reroute test, WSL; then
  // three more sites, macOS CI round 3): a fixed "(done: no-tool-call)"/"Saved …"/"Removed …" line
  // landing in the captured pty stdout is not a reliable proxy for "the write already happened"
  // (the file write itself is synchronous once persistDefaultModel/setConfigValue actually runs,
  // but nothing guarantees a captured stdout line and a DIFFERENT process's own filesystem read
  // observe that same moment in the same order on every runner — measured to differ on WSL and
  // again on macOS CI, never on Windows or ubuntu-latest, which is exactly what made this look
  // fixed after the first occurrence). A bare existence check is NOT enough on its own either:
  // several call sites here read a config.json that already EXISTS with OLD content (seedConfig's
  // own pre-write, or an earlier turn's own persist) before the assertion's own write is expected
  // to land — existence alone would return instantly against the stale content and never actually
  // wait for the NEW value, silently defeating the whole poll. `predicate` is what closes that
  // gap: every call site asserts on the SPECIFIC value it's about to check, so the poll can't
  // return before that value is genuinely present. Mirrors `sawLine`'s own bounded-poll idiom
  // (20ms interval, a deadline, not a flat sleep) for a file instead of a stdout string. Declared
  // here, before the first test, rather than lower in the file where it was first added (`function`
  // hoisting made a later declaration technically reachable from an earlier test too, but every
  // other helper in this file is declared before its own first use — this one now is too).
  async function waitForConfig(
    path: string,
    predicate: (config: Record<string, string>) => boolean,
    timeoutMs = 5000,
  ): Promise<Record<string, string>> {
    const deadline = Date.now() + timeoutMs;
    let config: Record<string, string> = {};
    while (Date.now() < deadline) {
      if (existsSync(path)) {
        config = JSON.parse(readFileSync(path, "utf8"));
        if (predicate(config)) return config;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    return config;
  }

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
      // persist (if any) happens — the write itself is synchronous by that point, but a captured
      // pty stdout line and a DIFFERENT process's own filesystem read are not guaranteed to
      // observe that moment in the same order on every runner (macOS CI, round 3: this exact
      // ENOENT). waitForConfig polls for the actual expected value instead of assuming.
      await sawLineTimes("(done: no-tool-call)", 2);
      const config = await waitForConfig(
        join(dir, ".seri", "config.json"),
        (c) => c.SERI_MODEL === "llama-3.3-70b-versatile",
      );
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

      // waitForConfig, not a bare readFileSync right after sawLineTimes — the same race macOS CI
      // caught elsewhere in this file (waitForConfig's own comment).
      const config = await waitForConfig(
        join(dir, ".seri", "config.json"),
        (c) => c.SERI_MODEL === "claude-sonnet-5",
      );
      expect(config.SERI_MODEL).toBe("claude-sonnet-5");
      expect(config.SERI_PROVIDER).toBe("anthropic");
      // Negative control: the OTHER route to the same model must not be what persisted.
      expect(config.SERI_PROVIDER).not.toBe("openrouter");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // D4's own real, still-reachable path — see childScriptModelPickRerouted's own comment for why
  // this is the ONLY scenario left alive after D3's fix.
  test("a live /model pick to a route that itself reroutes persists the RESOLVED provider, not the one literally picked (D4)", async () => {
    const scriptPath = join(dir, "child-model-pick-rerouted.mjs");
    writeFileSync(scriptPath, childScriptModelPickRerouted(dir));

    const { child, sawLine, sawLineTimes } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_CALL 1 model=openai/gpt-oss-120b provider=groq");
      await sawLine("(done: no-tool-call)");

      // Turn 1 ran on the session's own starting pair (GROQ_API_KEY configured, no reroute) — the
      // pre-condition this test needs: nothing persisted yet, so a later write is provably new.
      expect(existsSync(join(dir, ".seri", "config.json"))).toBe(false);

      child.stdin?.write("/model");
      await sawLine("/model");
      child.stdin?.write("\r");
      await sawLine("Route");

      // Multi-term filtering (App.tsx's own matchesFilter, D1/D2 commit) narrows to EXACTLY the
      // openrouter row: "claude-sonnet-5" matches both routes' own id, "openrouter" matches only
      // this row's own provider field — sidesteps needing an arrow-key press to reach a specific
      // row within a group, and picks the route that deliberately has NO key, which is the whole
      // point of this test (proving the LATER reroute, not the literal pick, is what persists).
      child.stdin?.write("claude-sonnet-5 openrouter");
      await sawLine("claude-sonnet-5 openrouter");
      child.stdin?.write("\r");
      // The mandatory wait after a keypress that swaps the mounted component (picker -> input
      // box) — childScriptModelSwitch's own test has the full measured story for this.
      await new Promise((resolve) => setTimeout(resolve, 100));

      child.stdin?.write("a second task");
      await sawLine("a second task");
      child.stdin?.write("\r");

      // Rerouted: the picked provider (openrouter) has no key, but anthropic — claude-sonnet-5's
      // native sibling — does, so resolveRoute reroutes turn 2 there (D2).
      await sawLine("RUNLOOP_CALL 2 model=claude-sonnet-5 provider=anthropic");
      // The transcript notice must name the PICKED provider (openrouter, the one actually
      // missing a key), not stay silent about it — proof that `session.provider`, set by the
      // live picker pick (reducer.ts's own "model-picker-resolved" case), actually reached this
      // turn's reroute notice rather than a re-derived undefined. Split across two checks, not
      // one long toContain: Ink wraps this line across the terminal's own column width (measured
      // the same way on the "a routing-priority reroute active from session start" test, below).
      const noticePrefix = "↻ routing claude-sonnet-5 via anthropic (your key) — no OpenRouter key";
      await sawLine(noticePrefix);
      await sawLine("configured");
      await sawLineTimes("(done: no-tool-call)", 2);
      // "(done: no-tool-call)" appearing in the captured pty stdout is not a reliable proxy for
      // "config.json has already been written" — measured live, waiting on it alone flaked here.
      // Poll for the actual content instead (waitForConfig's own comment).
      const config = await waitForConfig(
        join(dir, ".seri", "config.json"),
        (c) => c.SERI_MODEL === "claude-sonnet-5",
      );
      expect(config.SERI_MODEL).toBe("claude-sonnet-5");
      // D4: the RESOLVED pair persists, not the one literally selected in the picker.
      expect(config.SERI_PROVIDER).toBe("anthropic");
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

      // Sabotage the NEXT persist attempt before it happens: atomicWriteFile.ts (the shared
      // write-tmp-then-rename helper writeConfig now goes through) checks the destination
      // DIRECTORY is writable before doing anything else — chmod 0o500 (no write bit) makes that
      // check throw EACCES, the same class of failure a read-only config dir or a full disk would
      // produce. Not a pre-created `config.json.tmp` colliding by name (the old mechanism): the
      // tmp filename is pid+random now (atomicWriteFile.ts's own comment on why), so a fixed name
      // can no longer collide with anything, and config.json does not exist yet at this point for
      // a destination-FILE-permission sabotage (atomicWriteFile.ts's own comment on why that check
      // only applies to an existing destination) to have anything to act on either.
      const configDir = join(dir, ".seri");
      mkdirSync(configDir, { recursive: true });
      chmodSync(configDir, 0o500);

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
      chmodSync(configDir, 0o700);

      child.stdin?.write("a third task");
      await sawLine("a third task");
      child.stdin?.write("\r");

      await sawLine(
        "RUNLOOP_CALL 3 model=llama-3.3-70b-versatile messages=5 systemHasModelId=true",
      );
      await sawLineTimes("(done: no-tool-call)", 3);
      // waitForConfig, not a bare readFileSync right after sawLineTimes — the same race macOS CI
      // caught elsewhere in this file (waitForConfig's own comment).
      const config = await waitForConfig(
        join(configDir, "config.json"),
        (c) => c.SERI_MODEL === "llama-3.3-70b-versatile",
      );
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
      // Same mechanism as that test — see its own comment for why this is a directory-writability
      // chmod rather than a pre-created `config.json.tmp` colliding by name.
      const configDir = join(dir, ".seri");
      mkdirSync(configDir, { recursive: true });
      chmodSync(configDir, 0o500);

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

      // Bug fixed here (macOS CI, round 3): this went straight to `occurrences()` with no
      // preceding `sawLine` for the SAME text — unlike every other occurrences() check in this
      // file (the argv-task/second-task echo checks, above), which all wait for the line to
      // actually land before counting it. `occurrences()` is a synchronous snapshot of whatever is
      // CURRENTLY captured; "(done: no-tool-call)" appearing is not proof the warning (printed
      // earlier in the same turn, but via a different stream — printWarning is console.error, the
      // done line is Ink's own stdout render) has also reached the captured buffer yet. Waiting for
      // it explicitly first is what makes the count below actually mean something.
      await sawLine("could not save the default model:");
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

  // Regression: onSessionChange fires on every state.session change, including a /model pick
  // itself — before any turn confirms it. Picking a keyless provider and letting the turn fail
  // (no messages-updated, so confirmedModel never advances) is what proves a persist landing in
  // that window writes the still-confirmed starting provider, not the newer, unconfirmed pick's
  // own live session field — the live picker's value never overwrites `confirmedModel` until a
  // turn actually succeeds on it.
  test("a /model pick to a keyless provider that fails never persists that provider as confirmed", async () => {
    const scriptPath = join(dir, "child-model-pick-keyless.mjs");
    writeFileSync(scriptPath, childScriptModelPickKeyless(dir));
    const sessionsDir = join(dir, "sessions");

    const { child, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_CALL 1 model=openai/gpt-oss-120b");
      await sawLine("(done: no-tool-call)");

      child.stdin?.write("/model");
      await sawLine("/model");
      child.stdin?.write("\r");
      await sawLine("GPT OSS 120B");

      // Narrows to exactly the two claude-sonnet-5 routes (same fixture as
      // childScriptModelMultiRoute's own test) — the native Anthropic row sorts first (byRoutePriority),
      // so it is already the highlighted row this Enter picks, same as that test's own comment explains.
      child.stdin?.write("claude-sonnet-5");
      await sawLine("claude-sonnet-5");
      await sawLine("anthropic");
      child.stdin?.write("\r");
      // The mandatory wait after any keypress that swaps the mounted component (picker -> input
      // box) — childScriptModelSwitch's own test has the full measured story for this.
      await new Promise((resolve) => setTimeout(resolve, 100));

      child.stdin?.write("a second task");
      await sawLine("a second task");
      child.stdin?.write("\r");

      // getModel's own real (uninjected) branch throwing missingKeyError — proof the turn actually
      // failed on the missing key rather than succeeding some other way.
      await sawLine("No Anthropic key configured. Run /setup to add one.");

      const sessionFile = readdirSync(sessionsDir).find((f) => f.endsWith(".json"));
      if (sessionFile === undefined) throw new Error("no session file written yet");
      const sessionPath = join(sessionsDir, sessionFile);

      // Polled, not asserted immediately: the pick's own persist happens in App.tsx's own
      // onSessionChange effect, which fires after the dispatch above, not synchronously with the
      // keypress — same reasoning as the /mode disk-poll test above.
      const deadline = Date.now() + 5_000;
      let onDisk: { provider?: string };
      do {
        onDisk = JSON.parse(readFileSync(sessionPath, "utf8"));
      } while (onDisk.provider === undefined && Date.now() < deadline);
      if (onDisk.provider === undefined) throw new Error("no provider persisted yet");

      // The actual invariant: the persisted provider is still "groq" — turn 1's confirmed pair —
      // never "anthropic", the picked-but-never-confirmed provider whose turn failed.
      expect(onDisk.provider).toBe("groq");
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
      // Bug fixed here (macOS CI, round 3): waited on "(done: …)" but never on "Hello world"
      // itself before counting it — the same missing-poll shape as the persist-warning occurrences
      // check above. Explicit wait first, matching every other occurrences() check in this file.
      await sawLine("Hello world");

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
      const noticePrefix = "↻ routing claude-sonnet-5 via anthropic (your key) — no OpenRouter key";
      await sawLine(noticePrefix);
      await sawLine("configured");
      await sawLine("(done: no-tool-call)");

      // Exactly one transcript notice for this one turn — the per-turn cap D2's own acceptance
      // criterion names, not a re-print on every messages-updated event within it.
      expect(occurrences(noticePrefix)).toBe(1);

      // Bug fixed here (reviewer-verifier, multi-provider-byok-phase-2): prepareSession's own
      // printWarning (D2's non-interactive-path notice, "⚠ routing…") used to fire unconditionally,
      // even on the TUI path — printing a SECOND notice for the same session-start reroute
      // alongside runTurn's own "↻ routing…" transcript line. printWarning's own "⚠ " prefix is
      // what distinguishes it from the transcript notice's "↻ " prefix, so this asserts the
      // console-only one never appears once Ink has actually mounted.
      expect(occurrences("⚠ routing")).toBe(0);

      // The negative control this test's own point rests on: verified by first removing D3's own
      // fix (initializing confirmedModel/lastPersistedModel from `prepared.session` instead of
      // `prepared.route`) and re-running this exact assertion — it failed, with config.json
      // present and SERI_PROVIDER: "anthropic" written on turn 1, confirming the assertion below
      // actually exercises the fix rather than being vacuously true.
      expect(existsSync(join(dir, ".seri", "config.json"))).toBe(false);

      // The session persists the RESOLVED provider (anthropic), not the originally env-requested
      // one (openrouter, which never had a key) — proof `confirmedModel` initializes from
      // `prepared.route`, not `prepared.session`, even on a session that starts already-rerouted.
      // This is also what a later resume reads back as `session.provider`: see cli.test.ts's own
      // "a resumed session's reroute notice blames the last-confirmed provider" test for the
      // end-to-end consequence of that on the notice text.
      const sessionsDir = join(dir, "sessions");
      const sessionFile = readdirSync(sessionsDir).find((f) => f.endsWith(".json"));
      if (sessionFile === undefined) throw new Error("no session file written yet");
      const sessionPath = join(sessionsDir, sessionFile);
      const deadline = Date.now() + 5_000;
      let onDisk: { provider?: string };
      do {
        onDisk = JSON.parse(readFileSync(sessionPath, "utf8"));
      } while (onDisk.provider === undefined && Date.now() < deadline);
      expect(onDisk.provider).toBe("anthropic");
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

        // waitForConfig, not a bare readFileSync right after sawLine — the same race macOS CI
        // caught elsewhere in this file (waitForConfig's own comment).
        const config = await waitForConfig(
          join(dir, ".seri", "config.json"),
          (c) => c.OPENROUTER_API_KEY === secret,
        );
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

    // Code-review finding (PR #73, round 3, item #1): Enter and Delete were dead in the real TUI
    // twice already — App.test.tsx's own unit test for this covers the same fix at the component
    // level, but "no test exercises this" is exactly what let the ordering bug through the
    // component-level pty suite twice, so this test uses raw Enter/Delete (never the 'a'/'r' letter
    // shortcuts every OTHER /setup pty test above uses) end to end against a real terminal.
    test("Enter opens the enter-key step and Delete requests removal, without using the 'a'/'r' letter shortcuts", async () => {
      seedConfig(dir, { OPENROUTER_API_KEY: "sk-or-existing" });
      const scriptPath = join(dir, "child-setup-enter-delete.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine, sawLineTimes } = startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/setup");
        await sawLine("/setup");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("/setup — provider API keys");

        // Down to openrouter (index 1), removable (config-sourced from seedConfig above).
        child.stdin?.write("\x1b[B");
        await wait100ms();
        // Raw Enter, not "a" — the whole point of this test.
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("OPENROUTER_API_KEY for openrouter");

        // Escape back to the list, re-selecting the same row, rather than typing a new value — add/
        // replace via Enter is already exercised at the component level (App.test.tsx); this test's
        // own job is proving Enter/Delete reach the TUI's real useInput wiring, not re-covering the
        // write path.
        child.stdin?.write("\x1b");
        await new Promise((resolve) => setTimeout(resolve, 30));
        await wait100ms();
        await sawLineTimes("/setup — provider API keys", 2);

        // Raw Delete (`\x1b[3~`, parse-keypress.js's own sequence — distinct from backspace's
        // `\x7f`), not "r".
        child.stdin?.write("\x1b[3~");
        await wait100ms();
        await sawLine("Remove OPENROUTER_API_KEY");

        child.stdin?.write("y");
        await sawLine("Removed OPENROUTER_API_KEY.");

        const config = await waitForConfig(
          join(dir, ".seri", "config.json"),
          (c) => c.OPENROUTER_API_KEY === undefined,
        );
        expect(config.OPENROUTER_API_KEY).toBeUndefined();
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

        // waitForConfig, not a bare readFileSync right after sawLine — config.json already EXISTS
        // here (seedConfig's own pre-write, above), so a bare existence check would return
        // instantly against the OLD value; the predicate is what actually waits for the replace.
        const config = await waitForConfig(
          join(dir, ".seri", "config.json"),
          (c) => c.OPENROUTER_API_KEY === "sk-or-replaced-value",
        );
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

        // waitForConfig, not a bare readFileSync right after sawLine — config.json already EXISTS
        // here (seedConfig's own pre-write, above) WITH the key about to be removed, so a bare
        // existence check would return instantly against the pre-removal content; the predicate is
        // what actually waits for the removal to land.
        const config = await waitForConfig(
          join(dir, ".seri", "config.json"),
          (c) => c.OPENROUTER_API_KEY === undefined,
        );
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

    // D8: an env-sourced row with NOTHING saved in config.json underneath it reports the
    // environment as its source and refuses removal — there is genuinely nothing to unset.
    test("an env-shadowed row with no config entry reports the environment as the source and refuses removal", async () => {
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

        // Refused — removable is false for an env row with NO config.json entry underneath it,
        // so the confirm-remove step never even opens: no "Remove OPENAI_API_KEY" prompt anywhere
        // in the transcript, and config.json is never even created (nothing else in this test
        // writes to it either).
        expect(occurrences("Remove OPENAI_API_KEY")).toBe(0);
        expect(existsSync(join(dir, ".seri", "config.json"))).toBe(false);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    // Bug fixed here (code-review, PR #73): an env-shadowed row WITH a config.json entry
    // underneath it (unlike the sibling test above) IS removable — providerKeyState's own
    // `hasConfigEntry` is independent of which source wins for display. Before the fix, this used
    // to be silently refused too (removable was read off `source === "config"`, which is always
    // false in this exact state), making a previously-saved /setup secret permanently unremovable
    // the moment the same-named env var got exported.
    test("an env-shadowed row WITH a config entry underneath is removable", async () => {
      seedConfig(dir, { OPENAI_API_KEY: "sk-openai-config-value" });
      const scriptPath = join(dir, "child-setup-env-shadow-removable.mjs");
      writeFileSync(scriptPath, childScriptSetupEnvShadow(dir));

      const { child, sawLine, occurrences } = startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/setup");
        await sawLine("/setup");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("/setup — provider API keys");
        // Item #5 (round 3): the row's OWN text distinguishes this removable case from the
        // sibling test's non-removable one — not the old "unset it in your shell" text (which
        // would be actively wrong here: 'r' genuinely removes the config.json entry underneath).
        await sawLine("config entry underneath — removable");
        expect(occurrences("set by $OPENAI_API_KEY in your environment")).toBe(0);

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

        // No longer refused: the confirm-remove step opens, and confirming it removes the
        // config.json entry — the env var still shadows the (now-absent) config value going
        // forward, but the stored secret itself is gone, which is the whole point of D8's fix.
        await sawLine("Remove OPENAI_API_KEY");
        child.stdin?.write("y");
        await sawLine("Removed OPENAI_API_KEY.");

        const config = await waitForConfig(
          join(dir, ".seri", "config.json"),
          (c) => c.OPENAI_API_KEY === undefined,
        );
        expect(config.OPENAI_API_KEY).toBeUndefined();
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    // Code-review finding (PR #73, round 2, item #1): round 1 only guarded the /setup-OPEN
    // interceptor (cli.ts's onSubmit) against a malformed config.json — this exercises the two
    // remaining call sites reached only AFTER the panel is already open, which round 1 missed:
    // onSetupRemove's own request branch (providerKeyState), and onSetupBack (setupListState via
    // the new dispatchSetupList wrapper). onSetupSelect is deliberately NOT exercised for a crash
    // here — this round's fix made it a pure PROVIDER_API_KEY_NAMES lookup with no I/O at all, so
    // it has nothing left to throw on; the "a" step below instead proves exactly that, by using it
    // successfully while config.json is still malformed.
    //
    // Title says "a clean command-error", not "instead of crashing the TUI": measured directly
    // (temporarily reverting both guards and re-running this test) — on this Bun/Ink combination, an
    // unguarded synchronous throw out of a `useInput` callback does NOT actually kill the process
    // (`emitInput`, ink/build/components/App.js's own `internal_eventEmitter.current.emit('input',
    // ...)`, survives it and the TUI keeps accepting input either way), so "still alive after"
    // cannot be this test's own discriminator. What the guard actually changes, confirmed by that
    // same revert: without it, Bun's own uncaught-exception printer dumps a multi-line, ANSI-colored
    // stack trace (a source excerpt plus "at providerKeyState (...)"/"at onSetupRemove (...)"
    // frames) straight into the pty, smeared across Ink's own managed screen redraw — which is what
    // the final assertion below checks is absent.
    test("a config.json that becomes malformed while /setup is already open degrades to a clean command-error, not a raw stack-trace dump", async () => {
      seedConfig(dir, { OPENROUTER_API_KEY: "sk-or-value" });
      const scriptPath = join(dir, "child-setup-malformed-config.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine, sawLineTimes, occurrences } = startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/setup");
        await sawLine("/setup");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("/setup — provider API keys");

        const configPath = join(dir, ".seri", "config.json");
        // Corrupted AFTER the panel already opened successfully once — the risk this test targets
        // is a SECOND read, from a call site reached only once /setup is already open.
        writeFileSync(configPath, "{not valid json");

        // openrouter (index 1) was removable while config.json was still valid — onSetupRemove's
        // own request branch (providerKeyState) is what actually hits the malformed file now.
        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("r");
        await sawLine("JSON Parse error");

        // Still on the list step (the failed read never reached a dispatch that would move it) —
        // "a" on the same row exercises onSetupSelect, which does no I/O after this round's fix and
        // so must succeed even with config.json still malformed.
        child.stdin?.write("a");
        await wait100ms();
        await sawLine("OPENROUTER_API_KEY for openrouter");

        // Escape from enter-key exercises onSetupBack -> dispatchSetupList -> decideSetupOpen, the
        // remaining full-scan read — same malformed file, same degrade. sawLineTimes, not sawLine:
        // the first "JSON Parse error" already satisfies a bare substring check instantly.
        child.stdin?.write("\x1b");
        await new Promise((resolve) => setTimeout(resolve, 30));
        await sawLineTimes("JSON Parse error", 2);

        // Restoring valid JSON and retrying proves the TUI actually recovered, not just that it
        // survived one bad read.
        writeFileSync(configPath, JSON.stringify({ OPENROUTER_API_KEY: "sk-or-value" }));
        child.stdin?.write("\x1b");
        await new Promise((resolve) => setTimeout(resolve, 30));
        await wait100ms();
        await sawLineTimes("/setup — provider API keys", 2);

        // The actual negative control this test rests on (this comment block's own top note): both
        // throws above are caught before either ever reaches a raw stack trace in the captured pty
        // output. Not "at providerKeyState" — Bun's own colorized frame renderer interleaves ANSI
        // codes INSIDE function names (confirmed by inspecting the raw, unguarded dump byte-for-byte:
        // "at " and "providerKeyState" are not contiguous), which would make that substring check
        // pass vacuously either way. A stack frame's file path is not interleaved the same way
        // (confirmed the same way), so this checks for that instead.
        expect(occurrences("provider/keys.ts")).toBe(0);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);
  });

  // Stage C (cli-commands-to-tui feature-plan.md): /login, /signup and /logout end to end on a
  // real pty. `seedAuth`, mirroring `seedConfig`'s own host-side pre-write above, so the /logout
  // test starts with a real session already on disk rather than exercising createAuthHandlers'
  // own "Not logged in." branch instead of the one it means to test.
  function seedAuth(target: string): void {
    const configDir = join(target, ".seri");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "auth.json"),
      JSON.stringify({
        accessToken: "seeded-access-token",
        refreshToken: "seeded-refresh-token",
        userId: "user-0",
        email: "seeded@example.com",
        obtainedAt: new Date().toISOString(),
      }),
    );
  }

  describe("/login, /signup, /logout", () => {
    test("the banner appears at mount when no auth.json exists, alongside the ordinary input box", async () => {
      const scriptPath = join(dir, "child-auth-banner.mjs");
      writeFileSync(scriptPath, childScriptAuth(dir));

      const { child, sawLine } = startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");
        await sawLine("Sign in with /login, or create an account with /signup");

        // Non-blocking proof: the ordinary input box still accepts a task, exactly as it would
        // with the banner absent — the pty counterpart of App.test.tsx's own "still typing" test.
        child.stdin?.write("still typing");
        await sawLine("still typing");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    // "The banner is gone from the newest frame" (App.test.tsx's own "clears the panel entirely,
    // restoring InputBox" test) is asserted there, at the component level, via lastFrame() — this
    // harness's `sawLine`/`occurrences` only see the WHOLE accumulated pty stdout, which still
    // contains the banner's original bytes from mount even after Ink redraws without it (every
    // other "X disappeared" case in this file — /setup's own cancel test — checks a FILE, not
    // stdout, for the same reason). This test's own job is end to end: the real login()/logout()
    // deps seam, the real reducer dispatches, and auth.json actually landing on disk.
    test("/login shows the device panel, then resolves: 'Logged in as …' lands in the transcript, auth.json exists, and the raw access token never reaches stdout", async () => {
      const scriptPath = join(dir, "child-auth-login.mjs");
      writeFileSync(scriptPath, childScriptAuth(dir));

      const { child, sawLine, exited } = startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");
        await sawLine("Sign in with /login, or create an account with /signup");

        child.stdin?.write("/login");
        await sawLine("/login");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("https://example.com/device");
        await sawLine("ABCD-1234");

        await sawLine("Logged in as fake@example.com");

        // waitForConfig, not a bare readFileSync right after sawLine — the same race macOS CI
        // caught elsewhere in this file (waitForConfig's own comment); auth.json's shape
        // (AuthSession) is all strings, same as the Record<string, string> that helper expects.
        const auth = await waitForConfig(
          join(dir, ".seri", "auth.json"),
          (c) => c.email === "fake@example.com",
        );
        expect(auth.email).toBe("fake@example.com");

        // The negative control at the process level: the raw access token must never have
        // reached stdout, checked against the WHOLE accumulated transcript.
        child.kill("SIGKILL");
        const { stdout } = await exited;
        expect(stdout).not.toContain("fake-access-token-must-never-print");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    // The regression this locks (coordinator follow-up on Stage C): before AuthPanel's own
    // useInput existed, a denied/expired device code left this exact screen up with no keyboard
    // path back at all — no press, Enter included, ever returned the input box. `childScriptAuth`'s
    // own /login test above only exercises the SUCCESS round-trip; this one drives
    // createAuthHandlers' own catch branch (cli.ts) in a real process.
    test("a failed /login shows the error, and a keypress returns to the ordinary input box", async () => {
      const scriptPath = join(dir, "child-auth-login-fails.mjs");
      writeFileSync(scriptPath, childScriptAuthLoginFails(dir));

      const { child, sawLine } = startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/login");
        await sawLine("/login");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("https://example.com/device");
        await sawLine("ABCD-1234");

        await sawLine("Authorization was denied.");

        child.stdin?.write("\r");
        await wait100ms();

        // Proves InputBox is actually back and accepting input, not merely that the process
        // survived — the same "still typing" convention this file's own auth-banner test above
        // uses for the identical claim.
        child.stdin?.write("still here");
        await sawLine("still here");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    // The real soft-lock this round closes, end to end (thermo-nuclear + code-review, round 4):
    // Escape on the device step, while the fake login's own poll never resolves at all — before
    // this, NOTHING dismissed "starting"/"device" and Ctrl-C fell through to a hard process kill.
    test("Escape abandons a stuck /login and returns to the ordinary input box", async () => {
      const scriptPath = join(dir, "child-auth-login-hangs.mjs");
      writeFileSync(scriptPath, childScriptAuthLoginHangs(dir));

      const { child, sawLine } = startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/login");
        await sawLine("/login");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("https://example.com/device");
        await sawLine("ABCD-1234");

        child.stdin?.write("\x1b"); // Escape
        // Escape's own ambiguity window — this file's own convention (the /setup cancel test's
        // own comment).
        await new Promise((resolve) => setTimeout(resolve, 30));
        await wait100ms();

        // Proves InputBox is actually back and accepting input, not merely that the process
        // survived — the fake's own poll is still hanging in the background at this point, so
        // this is also proof the abandoned attempt's own dispatches never landed on top of it.
        child.stdin?.write("abandoned, typing something else");
        await sawLine("abandoned, typing something else");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    // The actual regression lock for the round 5 bug (thermo-nuclear): childScriptAuthLoginRace's
    // own poll resolves ~1s AFTER Escape, checking the real AbortSignal itself — this is what
    // distinguishes "the poll was genuinely cancelled" from "cancellation doesn't exist and we
    // just stopped listening" (the previous hangs-forever fake could only prove the latter kind
    // of thing, never the former — reviewer's own framing). Before the round 5 fix, the fake's own
    // late resolution would have written auth.json and flipped the banner regardless of Escape.
    test("Escape really cancels a stuck /login: the poll's late resolution ~1s later never writes auth.json or logs in", async () => {
      const scriptPath = join(dir, "child-auth-login-race.mjs");
      writeFileSync(scriptPath, childScriptAuthLoginRace(dir));

      const { child, sawLine, occurrences } = startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/login");
        await sawLine("/login");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("https://example.com/device");
        await sawLine("ABCD-1234");

        child.stdin?.write("\x1b"); // Escape — well before the fake's own 1000ms delay resolves
        await new Promise((resolve) => setTimeout(resolve, 30));
        await wait100ms();

        // InputBox is back immediately, same as the hangs-forever test above.
        child.stdin?.write("still fine");
        await sawLine("still fine");

        // Now wait PAST the fake's own 1000ms delay, so its late resolution — aborted or not —
        // has had time to land either way, then assert it never acted.
        await new Promise((resolve) => setTimeout(resolve, 1300));

        expect(existsSync(join(dir, ".seri", "auth.json"))).toBe(false);
        // "Logged in as …" is a <Static> transcript line (App.tsx) — committed at most once, ever,
        // never reprinted by an unrelated redraw the way a live region (the banner) can be, so
        // occurrences() is a reliable absence check here specifically, unlike the banner text
        // itself (measured live: it redraws multiple times over the course of this test for
        // reasons unrelated to auth state, so a raw occurrence count on it can't tell "flipped
        // back on" apart from "just redrew" — the auth.json check above is this test's own proof
        // the banner's underlying STATE never flipped, which is the thing that actually matters).
        expect(occurrences("Logged in as fake@example.com")).toBe(0);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("/logout signs out: 'Logged out.' lands in the transcript, auth.json is cleared, and the banner returns", async () => {
      seedAuth(dir);
      const scriptPath = join(dir, "child-auth-logout.mjs");
      writeFileSync(scriptPath, childScriptAuth(dir));

      const { child, sawLine } = startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");
        // seedAuth already wrote auth.json before spawn — decideAuthOffer is false at mount, so no
        // banner line is expected yet here.

        child.stdin?.write("/logout");
        await sawLine("/logout");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("Logged out.");

        expect(existsSync(join(dir, ".seri", "auth.json"))).toBe(false);
        await sawLine("Sign in with /login, or create an account with /signup");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    // The gate-composition matrix's own zeroKeys x noAuth "both at once" cell, end to end:
    // reuses childScriptGuidedSetup (no key, no auth.json — the same script the "genuinely blank
    // first run" describe block below already uses) rather than a new script, since the scenario
    // is identical; only the assertions differ.
    test("gate composition: zero keys and no auth.json show both /setup and the auth banner; adding a key falls through to the main view with the banner still showing", async () => {
      const scriptPath = join(dir, "child-auth-gate-matrix.mjs");
      writeFileSync(scriptPath, childScriptGuidedSetup(dir));

      const { child, sawLine } = startChild(scriptPath, dir);
      try {
        await sawLine("/setup — provider API keys");
        await sawLine("Sign in with /login, or create an account with /signup");

        child.stdin?.write("a");
        await wait100ms();
        await sawLine("GROQ_API_KEY for groq");

        const secret = "sk-gate-matrix-secret";
        child.stdin?.write(secret);
        await wait100ms();
        child.stdin?.write("\r");
        await sawLine("Saved GROQ_API_KEY.");

        child.stdin?.write("\x1b");
        await new Promise((resolve) => setTimeout(resolve, 30));
        await sawLine("Route");

        child.stdin?.write("70b-versatile");
        await sawLine("70b-versatile");
        child.stdin?.write("\r");

        // The fall-through to the main view (prepareSession -> runTui), same sync point
        // childScriptGuidedSetup's own describe block below uses — and the banner is still
        // showing there too, since no /login has happened in this run.
        await sawLine("RUNLOOP_READY");
        await sawLine("Sign in with /login, or create an account with /signup");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);
  });

  // byok-guided-setup, feature-plan.md (Open 2, BYOK-KEY-STORAGE-AND-SETUP.md): before this fix,
  // run() called prepareSession unconditionally on a real TTY, which threw and hard-exited the
  // process (code 1) before Ink ever mounted whenever zero keys were configured anywhere — the
  // negative control (code-quality.md's "seen to fail" rule): reverting cli.ts's run() gate against
  // this exact script/assertion reproduces that exit, with no "/setup — provider API keys" text in
  // the captured stdout at all.
  describe("guided setup on a genuinely blank first run", () => {
    // byok-guided-setup-default-model bugfix report: closing /setup with at least one key
    // configured no longer falls straight through — it opens the mandatory model picker
    // (Decision 1), and only THAT resolves the panel. "Route" is the picker's own column header
    // (App.tsx's MODEL_PICKER_HEADER) — present regardless of catalog ordering, unlike any
    // specific row, so it is a reliable sync point for "the picker actually mounted."
    test("mounts /setup directly instead of hard-exiting, and falls through to the task once a key is added and the mandatory default model is picked", async () => {
      const scriptPath = join(dir, "child-guided-setup.mjs");
      writeFileSync(scriptPath, childScriptGuidedSetup(dir));

      const { child, sawLine } = startChild(scriptPath, dir);
      try {
        // No "/setup" keystroke sent — this must appear on its own, unlike every other /setup test
        // in this file, which types the command first.
        await sawLine("/setup — provider API keys");

        // Default cursor is groq (index 0, CATALOG_PROVIDERS order) — "a" opens its enter-key step,
        // the same shortcut the existing /setup "add" pty test above uses.
        child.stdin?.write("a");
        await wait100ms();
        await sawLine("GROQ_API_KEY for groq");

        const secret = "sk-guided-setup-secret";
        child.stdin?.write(secret);
        await wait100ms();
        child.stdin?.write("\r");
        await sawLine("Saved GROQ_API_KEY.");

        const config = await waitForConfig(
          join(dir, ".seri", "config.json"),
          (c) => c.GROQ_API_KEY === secret,
        );
        expect(config.GROQ_API_KEY).toBe(secret);

        // Back at the list step (setupListState re-selects groq) — Escape closes the panel, the
        // same close path the existing "cancel" /setup test above already exercises. Unlike
        // pre-fix, this does NOT fall straight through: a key is now configured, so onSetupClose
        // opens the mandatory model picker instead.
        child.stdin?.write("\x1b");
        await new Promise((resolve) => setTimeout(resolve, 30));
        await sawLine("Route");

        // Narrows to exactly one entry across the whole catalog (groq and openrouter both) —
        // verified directly against the bundled catalog-manifest.json (the /model multi-route
        // pty test's own comment, above, has the full story on why this exact string).
        child.stdin?.write("70b-versatile");
        await sawLine("70b-versatile");
        child.stdin?.write("\r");

        // The fall-through: prepareSession -> runTui -> driveLoop, unchanged, now actually reached.
        await sawLine("> do a task");
        await sawLine("RUNLOOP_READY");
        await sawLine("(done: no-tool-call)");

        const modelConfig = await waitForConfig(
          join(dir, ".seri", "config.json"),
          (c) => c.SERI_MODEL === "llama-3.3-70b-versatile",
        );
        expect(modelConfig.SERI_MODEL).toBe("llama-3.3-70b-versatile");
        expect(modelConfig.SERI_PROVIDER).toBe("groq");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    // Code-review finding, PR #91: run()'s own gate used to `await getModelCatalog()` BEFORE
    // calling runGuidedSetup, so a slow/offline models.dev blocked /setup's very first paint behind
    // FETCH_TIMEOUT_MS (10s, model-catalog's own catalog.ts) — a blank terminal on exactly the flow
    // this feature exists to make instant. childScriptGuidedSetupSlowFetch's own fetch never
    // resolves at all, so a 5s ceiling (well under that 10s timeout, still generous for a slow
    // runner) is the negative control: it fails against the pre-fix blocking await and passes once
    // the fetch is only kicked off, never awaited, ahead of the panel's first render.
    test("mounts /setup instantly even while the model catalog fetch is still in flight", async () => {
      const scriptPath = join(dir, "child-guided-setup-slow-fetch.mjs");
      writeFileSync(scriptPath, childScriptGuidedSetupSlowFetch(dir));

      const { child, sawLine } = startChild(scriptPath, dir);
      try {
        const start = Date.now();
        await sawLine("/setup — provider API keys");
        expect(Date.now() - start).toBeLessThan(5000);
      } finally {
        child.kill("SIGKILL");
      }
    }, 20_000);

    // Code-review finding (thermo-nuclear round 2, PR #91): making onSetupClose's own catalog wait
    // async (instead of chained) made it re-entrant — a second Escape press while `catalogPromise`
    // was still resolving re-ran the whole tail a second time, and the wait itself was silent (no
    // feedback between the keypress and the picker appearing). Reuses
    // childScriptGuidedSetupSlowFetch's own permanently-hanging fetch: `catalogPromise` never
    // settles within this test's own window, so this exercises exactly the dead-input/re-entrancy
    // half of the bug (the picker itself can never appear here — that half is what
    // childScriptGuidedSetupDelayedFetch's own test, below, covers).
    test("Escape during a slow catalog fetch shows visible feedback once, not duplicated by a second press", async () => {
      const scriptPath = join(dir, "child-guided-setup-slow-fetch-escape.mjs");
      writeFileSync(scriptPath, childScriptGuidedSetupSlowFetch(dir));

      const { child, sawLine, occurrences, exited } = startChild(scriptPath, dir);
      try {
        await sawLine("/setup — provider API keys");

        child.stdin?.write("a");
        await wait100ms();
        await sawLine("GROQ_API_KEY for groq");

        const secret = "sk-guided-setup-slow-fetch-secret";
        child.stdin?.write(secret);
        await wait100ms();
        child.stdin?.write("\r");
        await sawLine("Saved GROQ_API_KEY.");

        // First Escape: the visible-feedback line must appear even though catalogPromise never
        // resolves in this script.
        child.stdin?.write("\x1b");
        await wait100ms();
        await sawLine("Loading available models…");

        // A second Escape while still "closing": the re-entrancy guard must make this a no-op —
        // NOT a second run of the tail, which (pre-fix) would have re-dispatched the same
        // transcript line a second time.
        child.stdin?.write("\x1b");
        await wait100ms();
        expect(occurrences("Loading available models…")).toBe(1);

        // The process is still alive and responsive, not deadlocked — Ctrl-C still reaches the
        // same fatal idle path every other test in this describe block's Ctrl-C test exercises.
        child.stdin?.write("\x03");
        const { stdout } = await exited;
        expect(stdout).not.toContain("EXIT_CODE");
        expect(stdout).not.toContain("RUNLOOP_READY");
      } finally {
        child.kill("SIGKILL");
      }
    }, 20_000);

    // The other half of the same bug (see the test just above): a user who starts adding a SECOND
    // key while the first Escape's catalog wait is still pending must not have that in-progress
    // typing silently discarded when the fetch finally resolves and the picker would otherwise
    // want to mount over it (App.tsx's own render ternary checks pendingModelPicker before
    // pendingSetup). `childScriptGuidedSetupDelayedFetch` resolves after 3s — measured live to be
    // comfortably longer than this test's own first-key-save-and-Escape sequence takes (a 400ms
    // delay was tried first and measured to already have elapsed by the time Escape was pressed,
    // making the test vacuous — the picker had already opened before the second-key keystrokes
    // were even sent).
    test("adding a second key while the catalog fetch is still resolving is not discarded by the picker", async () => {
      const scriptPath = join(dir, "child-guided-setup-delayed-fetch.mjs");
      writeFileSync(scriptPath, childScriptGuidedSetupDelayedFetch(dir));

      const { child, sawLine } = startChild(scriptPath, dir);
      try {
        await sawLine("/setup — provider API keys");

        child.stdin?.write("a");
        await wait100ms();
        await sawLine("GROQ_API_KEY for groq");

        const secret = "sk-guided-setup-delayed-fetch-secret";
        child.stdin?.write(secret);
        await wait100ms();
        child.stdin?.write("\r");
        await sawLine("Saved GROQ_API_KEY.");

        // Escape starts the (still-pending) catalog wait.
        child.stdin?.write("\x1b");
        await wait100ms();
        await sawLine("Loading available models…");

        // Immediately start adding a SECOND key — well before the 3s delayed fetch resolves.
        // CATALOG_PROVIDERS order is groq, openrouter, ... — one Down reaches openrouter.
        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("a");
        await wait100ms();
        await sawLine("OPENROUTER_API_KEY for openrouter");

        // If the picker silently replaced this mid-typing (the bug), the rest of this input would
        // land in ModelPicker's own filter box instead, and "Saved OPENROUTER_API_KEY." would
        // never print — sawLine's own bounded poll is what turns that into a real test failure
        // rather than a hang.
        const secondSecret = "sk-guided-setup-second-key-secret";
        child.stdin?.write(secondSecret);
        await wait100ms();
        child.stdin?.write("\r");
        await sawLine("Saved OPENROUTER_API_KEY.");

        const config = await waitForConfig(
          join(dir, ".seri", "config.json"),
          (c) => c.OPENROUTER_API_KEY === secondSecret,
        );
        expect(config.OPENROUTER_API_KEY).toBe(secondSecret);
        expect(config.GROQ_API_KEY).toBe(secret);

        // The flow still completes normally afterward: back at the list step, a fresh Escape opens
        // the picker (catalogPromise is long since resolved by now).
        child.stdin?.write("\x1b");
        await wait100ms();
        await sawLine("Route");
      } finally {
        child.kill("SIGKILL");
      }
    }, 20_000);

    // Code-review finding, PR #91 round 3: `onSetupClose`'s own `configured` snapshot was captured
    // BEFORE this wait, then reused once the catalog resolved — a remove-then-confirm round-trip
    // during the wait returns to the "list" step (the only thing the re-entrancy guard above
    // checks) without ever tripping it, so the stale snapshot could still show the just-removed
    // provider as configured. Negative control: pre-fix, this test's own final assertions fail —
    // the mandatory picker opens instead, offering a model for a provider with no key left.
    test("removing the only key while the catalog fetch is still resolving does not open the picker for it", async () => {
      const scriptPath = join(dir, "child-guided-setup-remove-during-wait.mjs");
      writeFileSync(scriptPath, childScriptGuidedSetupDelayedFetch(dir));

      const { child, sawLine, exited } = startChild(scriptPath, dir);
      try {
        await sawLine("/setup — provider API keys");

        child.stdin?.write("a");
        await wait100ms();
        await sawLine("GROQ_API_KEY for groq");

        const secret = "sk-guided-setup-remove-during-wait-secret";
        child.stdin?.write(secret);
        await wait100ms();
        child.stdin?.write("\r");
        await sawLine("Saved GROQ_API_KEY.");

        // Escape starts the (still-pending, 3s) catalog wait.
        child.stdin?.write("\x1b");
        await wait100ms();
        await sawLine("Loading available models…");

        // Remove the only configured key well before the 3s delayed fetch resolves — 'r' then 'y'
        // returns to the "list" step without ever tripping the guard above.
        child.stdin?.write("r");
        await wait100ms();
        child.stdin?.write("y");
        await sawLine("Removed GROQ_API_KEY.");

        // Once the delayed fetch resolves, the mandatory picker must NOT open for a provider that
        // no longer has a key — this falls through to the same decline/missing-key path a genuine
        // zero-key close takes.
        const { stdout } = await exited;
        expect(stdout).toContain("EXIT_CODE 1");
        expect(stdout).toContain(
          "GROQ_API_KEY is not set. Run: seri config set GROQ_API_KEY <your-key>",
        );
        expect(stdout).not.toContain("Pick a default model to continue.");
      } finally {
        child.kill("SIGKILL");
      }
    }, 20_000);

    // Code-review finding, PR #91 round 3: from the "enter-key" step, Ctrl-D calls onSetupClose
    // directly (SetupEnterKey's own useInput) — while the wait's `closing` guard was a bare no-op,
    // this looked like a completely dead key with zero feedback. Negative control: pre-fix, this
    // test's own final assertion (the "still loading" message) never appears.
    test("Ctrl-D from the enter-key step during the catalog wait gives visible feedback, not a dead key", async () => {
      const scriptPath = join(dir, "child-guided-setup-ctrld-during-wait.mjs");
      writeFileSync(scriptPath, childScriptGuidedSetupDelayedFetch(dir));

      const { child, sawLine } = startChild(scriptPath, dir);
      try {
        await sawLine("/setup — provider API keys");

        child.stdin?.write("a");
        await wait100ms();
        await sawLine("GROQ_API_KEY for groq");

        const secret = "sk-guided-setup-ctrld-during-wait-secret";
        child.stdin?.write(secret);
        await wait100ms();
        child.stdin?.write("\r");
        await sawLine("Saved GROQ_API_KEY.");

        // Escape starts the (still-pending, 3s) catalog wait.
        child.stdin?.write("\x1b");
        await wait100ms();
        await sawLine("Loading available models…");

        // Navigate to "enter-key" for a second provider, still well before the 3s delayed fetch
        // resolves.
        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("a");
        await wait100ms();
        await sawLine("OPENROUTER_API_KEY for openrouter");

        // Ctrl-D here reaches onSetupClose directly (SetupEnterKey's own useInput) while `closing`
        // is still true.
        child.stdin?.write("\x04");
        await sawLine("Still loading available models");
      } finally {
        child.kill("SIGKILL");
      }
    }, 20_000);

    // The bug this whole loop exists to fix: an anthropic-only guided setup used to fall through
    // to prepareSession unconditionally, which resolved the untouched default (groq's
    // openai/gpt-oss-120b) and hard-exited on a SECOND missing-key error naming a provider the
    // user never configured. The mandatory picker (Decision 1) closes that gap.
    test("a non-groq key added during guided setup lands on the model picked there instead of a second missing-GROQ_API_KEY exit", async () => {
      const scriptPath = join(dir, "child-guided-setup-non-groq.mjs");
      writeFileSync(scriptPath, childScriptGuidedSetup(dir));

      const { child, sawLine, occurrences } = startChild(scriptPath, dir);
      try {
        await sawLine("/setup — provider API keys");

        // CATALOG_PROVIDERS order is groq, openrouter, anthropic, openai, google — two Downs
        // reach anthropic (same navigation the /setup "remove" pty tests above already use).
        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("a");
        await wait100ms();
        await sawLine("ANTHROPIC_API_KEY for anthropic");

        const secret = "sk-ant-guided-setup-secret";
        child.stdin?.write(secret);
        await wait100ms();
        child.stdin?.write("\r");
        await sawLine("Saved ANTHROPIC_API_KEY.");

        child.stdin?.write("\x1b");
        await new Promise((resolve) => setTimeout(resolve, 30));
        await sawLine("Route");

        // Narrows to exactly the two claude-sonnet-5 routes in the bundled manifest (the /model
        // multi-route pty test's own comment, above, verified this directly against
        // catalog-manifest.json). byRoutePriority (D2) sorts native before aggregator within a
        // route group, so the native anthropic row is already the top/default-selected one for
        // this filtered query — no Down press needed.
        child.stdin?.write("claude-sonnet-5");
        await sawLine("claude-sonnet-5");
        child.stdin?.write("\r");

        await sawLine("> do a task");
        await sawLine("RUNLOOP_READY");
        await sawLine("(done: no-tool-call)");

        const config = await waitForConfig(
          join(dir, ".seri", "config.json"),
          (c) => c.SERI_MODEL === "claude-sonnet-5",
        );
        expect(config.SERI_MODEL).toBe("claude-sonnet-5");
        expect(config.SERI_PROVIDER).toBe("anthropic");
        // The negative control this test exists for: the exact string pre-fix code printed here,
        // naming a provider (groq) the user never configured.
        expect(occurrences("GROQ_API_KEY is not set")).toBe(0);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    // Decision 2: Esc/Ctrl-D at the mandatory picker re-prompts — it must never resolve the panel
    // and fall through to a keys-but-no-model run, which is exactly the bug this loop fixes.
    test("Escape at the mandatory model picker re-prompts instead of returning to a keys-but-no-model run", async () => {
      const scriptPath = join(dir, "child-guided-setup-picker-escape.mjs");
      writeFileSync(scriptPath, childScriptGuidedSetup(dir));

      const { child, sawLine } = startChild(scriptPath, dir);
      try {
        await sawLine("/setup — provider API keys");

        child.stdin?.write("a");
        await wait100ms();
        await sawLine("GROQ_API_KEY for groq");

        const secret = "sk-guided-setup-escape-secret";
        child.stdin?.write(secret);
        await wait100ms();
        child.stdin?.write("\r");
        await sawLine("Saved GROQ_API_KEY.");

        child.stdin?.write("\x1b");
        await new Promise((resolve) => setTimeout(resolve, 30));
        await sawLine("Route");

        // Escape at the picker: must re-prompt, not resolve.
        child.stdin?.write("\x1b");
        await wait100ms();
        await sawLine("Pick a model to continue");

        // The picker is still up: a subsequent filter keystroke still narrows it, and config.json
        // still has no SERI_MODEL — proof Escape neither closed the picker nor let the run
        // continue on a keys-but-no-model session.
        child.stdin?.write("70b-versatile");
        await sawLine("70b-versatile");
        const configDuringEscape = JSON.parse(
          readFileSync(join(dir, ".seri", "config.json"), "utf8"),
        );
        expect(configDuringEscape.SERI_MODEL).toBeUndefined();

        // Filter + Enter then falls through normally, proving the picker recovered rather than
        // being left in some broken half-cancelled state.
        child.stdin?.write("\r");
        await sawLine("> do a task");
        await sawLine("RUNLOOP_READY");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    // Decision 2's own Ctrl-C carve-out: with no `cancel` slot registered for this mount,
    // deliverSignal takes the fatal branch and kills the process by signal — never resolving
    // `closed`, so nothing is ever persisted from a run that dies here.
    test("Ctrl-C at the mandatory model picker kills the run without persisting a default model", async () => {
      const scriptPath = join(dir, "child-guided-setup-picker-ctrlc.mjs");
      writeFileSync(scriptPath, childScriptGuidedSetup(dir));

      const { child, sawLine, exited } = startChild(scriptPath, dir);
      try {
        await sawLine("/setup — provider API keys");

        child.stdin?.write("a");
        await wait100ms();
        await sawLine("GROQ_API_KEY for groq");

        const secret = "sk-guided-setup-ctrlc-secret";
        child.stdin?.write(secret);
        await wait100ms();
        child.stdin?.write("\r");
        await sawLine("Saved GROQ_API_KEY.");

        child.stdin?.write("\x1b");
        await new Promise((resolve) => setTimeout(resolve, 30));
        await sawLine("Route");

        child.stdin?.write("\x03");
        const { stdout } = await exited;

        // The child died by signal before childScriptGuidedSetup's own
        // `console.log("EXIT_CODE " + code)` (helper, above) — and driveLoop/runTui never ran, so
        // neither line was ever printed.
        expect(stdout).not.toContain("EXIT_CODE");
        expect(stdout).not.toContain("RUNLOOP_READY");

        const config = JSON.parse(readFileSync(join(dir, ".seri", "config.json"), "utf8"));
        expect(config.GROQ_API_KEY).toBe(secret);
        expect(config.SERI_MODEL).toBeUndefined();
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("closing /setup with no key added exits with a non-zero code and prints the same missing-key message as the non-interactive exit", async () => {
      const scriptPath = join(dir, "child-guided-setup-decline.mjs");
      writeFileSync(scriptPath, childScriptGuidedSetup(dir));

      const { child, sawLine, exited } = startChild(scriptPath, dir);
      try {
        await sawLine("/setup — provider API keys");

        child.stdin?.write("\x1b"); // Escape, no key added
        await new Promise((resolve) => setTimeout(resolve, 30));

        // Asserted on stdout's own EXIT_CODE line, not the pty's own exit status —
        // childScriptQuit's own sibling tests (above) explain why: the pty allocator (python3)
        // reports its own exit status, not the grandchild bun process's.
        const { stdout } = await exited;
        expect(stdout).toContain("EXIT_CODE 1");
        // Thermo-nuclear finding (round 4): run()'s old re-check `return 1`'d here with no
        // console.error, silently discarding missingKeyError's own default message. Falling
        // through to prepareSession's identical catch instead means a decline prints the exact
        // message a non-interactive missing-key run does — this assertion is the negative
        // control: it fails against that old silent `return 1`.
        expect(stdout).toContain(
          "GROQ_API_KEY is not set. Run: seri config set GROQ_API_KEY <your-key>",
        );
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);
  });

  // Stage D (cli-commands-to-tui feature-plan.md): /config end to end on a real pty. Reuses
  // childScriptSetup's exact env/deps (HOME=dir, so config.json lands at <dir>/.seri/config.json,
  // the same place waitForConfig already polls for /setup) — /config reads/writes config.json
  // through the identical `configDir` resolution /setup does.
  describe("/config", () => {
    test("add a value for a known key, then unset it — the typed value never leaks while being entered", async () => {
      const scriptPath = join(dir, "child-config.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine, occurrences } = startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/config");
        await sawLine("/config");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("/config — settings");

        // KNOWN_CONFIG_KEYS order (tui/commands.ts): SERI_WORKOS_CLIENT_ID, SERI_VERIFY_ENABLED,
        // SERI_VERIFY_COMMAND — two Down presses reach the third.
        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("a");
        await wait100ms();
        await sawLine("value for SERI_VERIFY_COMMAND");

        const value = "bun run check";
        child.stdin?.write(value);
        await wait100ms();
        // Negative control: while the value is still only ConfigEnterValue's own local state, the
        // typed characters render as asterisks (its own credential-disclosure guard, applied
        // unconditionally, not just for secret-shaped keys) — so the raw string must not have
        // reached the pty's stdout yet. Not asserted after Enter too: SERI_VERIFY_COMMAND's own
        // `secret: false` (decideConfigOpen's own comment — a command a user should be able to
        // read back, not see as asterisks) means the list's post-save refresh legitimately shows
        // it, by design, so a whole-run negative control would be asserting against the code's own
        // documented behavior rather than a leak.
        expect(occurrences(value)).toBe(0);

        child.stdin?.write("\r");
        await sawLine("Saved SERI_VERIFY_COMMAND.");

        const config = await waitForConfig(
          join(dir, ".seri", "config.json"),
          (c) => c.SERI_VERIFY_COMMAND === value,
        );
        expect(config.SERI_VERIFY_COMMAND).toBe(value);

        child.stdin?.write("r");
        await wait100ms();
        await sawLine("Unset SERI_VERIFY_COMMAND");

        child.stdin?.write("y");
        await sawLine("Removed SERI_VERIFY_COMMAND.");

        const afterRemoval = await waitForConfig(
          join(dir, ".seri", "config.json"),
          (c) => c.SERI_VERIFY_COMMAND === undefined,
        );
        expect(afterRemoval.SERI_VERIFY_COMMAND).toBeUndefined();
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);
  });

  // Stage D (cli-commands-to-tui feature-plan.md): /permissions end to end on a real pty. Unlike
  // every other seed helper in this file (seedConfig writes raw JSON), permissions.yaml's exact
  // shape (comments, flow style — permissions/store.ts's own writeDocument comment) is a real
  // dependency contract, not something worth hand-rolling here: `rememberGrant`/`loadGrants` are
  // imported for real, the same injection-free "call the actual function" choice childScriptAuth's
  // own comment already makes for auth.json. `worktree` is `dir` itself, matching what the CHILD
  // resolves via checkpointTarget → projectRoot(process.cwd()): `dir` is a fresh tmpdir with no
  // enclosing git repo, so projectRoot falls back to `resolve(dir)`, the same value projectKey
  // resolves here.
  describe("/permissions", () => {
    test("a persisted write_file grant renders, and 'r'/'y' removes it", async () => {
      const permissionsDir = join(dir, "config");
      // realpathSync, not the raw mkdtempSync path: os.tmpdir() on macOS resolves under
      // /var/folders/…, itself a symlink to /private/var/folders/… — the CHILD's own
      // process.cwd() (spawned with cwd: dir) comes back through the OS's getcwd(), which
      // follows that symlink, so a projectKey computed here from the unresolved `dir` never
      // matches the one the child computes from its own resolved cwd. Scoped to this local
      // `worktree`, not applied to the shared `dir` itself: `dir` also feeds childScriptSetup's
      // HOME (a literal env-var string, never OS-resolved) and this describe block's other
      // tests, and lengthening it broke /profile new's own pty test via terminal line-wrapping
      // on macOS CI (measured: the confirmation line's word boundary moved mid-sentence).
      const worktree = realpathSync(dir);
      const { rememberGrant, loadGrants } = await import("../../src/permissions/store");
      rememberGrant(permissionsDir, worktree, "write_file");

      const scriptPath = join(dir, "child-permissions.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine } = startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/permissions");
        await sawLine("/permissions");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("/permissions — tools approved permanently");
        await sawLine("write_file (persisted)");

        child.stdin?.write("r");
        await wait100ms();
        await sawLine("Remove write_file");

        child.stdin?.write("y");
        await sawLine("Removed write_file.");

        // Polling, not a bare synchronous read right after sawLine — the same file-vs-stdout race
        // waitForConfig's own comment documents for config.json, here for permissions.yaml instead.
        const deadline = Date.now() + 5000;
        let grants = loadGrants(permissionsDir, worktree);
        while (grants.project.includes("write_file") && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 20));
          grants = loadGrants(permissionsDir, worktree);
        }
        expect(grants.project).not.toContain("write_file");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    // Regression test for the bug /code-review and thermo-nuclear both found on this PR: removing
    // the "persisted" row used to call forgetGrant unscoped, which strips a same-tool GLOBAL grant
    // too — even though decidePermissionsOpen only ever shows this row as removable because of its
    // PROJECT-tier membership. The store-level test (permissions/store.test.ts) pins forgetGrant's
    // own scope handling; this is the one that pins the call site that actually had the bug —
    // cli.ts's onPermissionsRemove passing "project" rather than "both" — which nothing else here
    // exercises (confirmed: reverting that one argument keeps every other test in this suite green).
    test("a global grant survives removing the same tool's project-tier entry", async () => {
      const permissionsDir = join(dir, "config");
      // realpathSync — see the sibling test's own comment just above for why this is scoped to
      // a local `worktree` rather than the shared `dir`.
      const worktree = realpathSync(dir);
      const { loadGrants, permissionsPath, projectKey } = await import(
        "../../src/permissions/store"
      );
      // Hand-written, not rememberGrant after a global seed: rememberGrant's own dedup
      // (toolsInDoc) checks the tool's presence across BOTH tiers before writing, so seeding
      // global first would make it silently refuse to also add the project entry.
      mkdirSync(permissionsDir, { recursive: true });
      writeFileSync(
        permissionsPath(permissionsDir),
        `global: [write_file]\nprojects:\n  '${projectKey(worktree)}':\n    - write_file\n`,
      );

      const scriptPath = join(dir, "child-permissions-global.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine } = startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/permissions");
        await sawLine("/permissions");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("write_file (persisted)");

        child.stdin?.write("r");
        await wait100ms();
        await sawLine("Remove write_file");

        child.stdin?.write("y");
        await sawLine("still pre-approved globally");

        const deadline = Date.now() + 5000;
        let grants = loadGrants(permissionsDir, worktree);
        while (grants.project.includes("write_file") && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 20));
          grants = loadGrants(permissionsDir, worktree);
        }
        expect(grants.project).not.toContain("write_file");
        expect(grants.global).toContain("write_file");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);
  });

  // cli-tui-stage-b-bare-seri, feature-plan.md Stage B acceptance criteria: bare `seri` in a real
  // TTY mounts the TUI idle (no positionals, no --continue/--resume) instead of hard-exiting with
  // USAGE, and does not auto-start a turn the way `seri --continue` still does.
  describe("bare seri", () => {
    test("mounts idle with no auto-started turn; a typed task starts one; Ctrl-D then exits 0", async () => {
      const scriptPath = join(dir, "child-bare.mjs");
      writeFileSync(scriptPath, childScriptBare(dir));

      const { child, sawLine, exited, occurrences } = startChild(scriptPath, dir);
      try {
        // The mode-indicator/input box's own default-session label (modeIndicator, reducer.ts) —
        // proof the TUI actually mounted rather than the process just sitting there.
        await sawLine("[approve-each]");
        // Negative control: nothing auto-started a turn. wait100ms first, matching every other
        // occurrences()-based negative control in this file (the seedConfig-adjacent /setup tests
        // above) — occurrences() is a synchronous snapshot, so it has to be given time to be wrong
        // before it can prove RUNLOOP_READY genuinely never printed.
        await wait100ms();
        expect(occurrences("RUNLOOP_READY")).toBe(0);

        child.stdin?.write("do a task");
        await sawLine("do a task");
        child.stdin?.write("\r");
        await sawLine("RUNLOOP_READY");
        await sawLine("> do a task");
        expect(occurrences("RUNLOOP_READY")).toBe(1);

        child.stdin?.write("\x04");
        const result = await Promise.race([
          exited,
          new Promise<"the run never settled">((r) =>
            setTimeout(() => r("the run never settled"), 15_000),
          ),
        ]);
        expect(result).not.toBe("the run never settled");
        const { stdout } = result as Exit;
        expect(stdout).toContain("EXIT_CODE 0");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    // The spec's own named acceptance test (feature-plan.md finding #7): a fresh, non-resuming,
    // task-less TTY invocation must persist NO empty-content user message — the latent
    // `hasNewTask`/`prepareSession` bug bare-seri-mounts-the-TUI exists to fix, not just the
    // positionals.length===0 hard exit. Asserted on the session JSON's own `messages` array, not a
    // rendered line — a rendered transcript has nothing to show for a message that was pushed to
    // `session.messages` in memory but never echoed (echoUserInput is gated on `hasNewTask` too, so
    // the old bug wouldn't have shown up as a rendered line either).
    test("quitting immediately, with nothing ever typed, persists no empty-content user message", async () => {
      const scriptPath = join(dir, "child-bare-quit.mjs");
      writeFileSync(scriptPath, childScriptBare(dir));

      const { child, sawLine, exited } = startChild(scriptPath, dir);
      try {
        await sawLine("[approve-each]");
        await wait100ms();

        child.stdin?.write("\x04");
        const result = await Promise.race([
          exited,
          new Promise<"the run never settled">((r) =>
            setTimeout(() => r("the run never settled"), 15_000),
          ),
        ]);
        expect(result).not.toBe("the run never settled");
        const { stdout } = result as Exit;
        expect(stdout).toContain("EXIT_CODE 0");

        const sessionsDir = join(dir, "sessions");
        const sessionFiles = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];
        expect(sessionFiles).toHaveLength(1);
        const session = JSON.parse(readFileSync(join(sessionsDir, sessionFiles[0]!), "utf8"));
        expect(session.messages).not.toContainEqual({ role: "user", content: "" });
        expect(session.messages).toEqual([]);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);
  });

  describe("/max-turns", () => {
    test("typed live before a task, the next turn's driveLoop call receives the override", async () => {
      const scriptPath = join(dir, "child-max-turns.mjs");
      writeFileSync(scriptPath, childScriptMaxTurns(dir));

      const { child, sawLine } = startChild(scriptPath, dir);
      try {
        await sawLine("[approve-each]");

        child.stdin?.write("/max-turns 1");
        await sawLine("/max-turns 1");
        child.stdin?.write("\r");
        await sawLine("Max turns set to 1");

        // The typed-box render, un-prefixed — "> do a task" is echoUserInput's OWN prefix,
        // produced only after submit (Enter), so waiting for it before pressing Enter would never
        // resolve. Same wait-then-submit shape as "/max-turns 1" just above.
        child.stdin?.write("do a task");
        await sawLine("do a task");
        child.stdin?.write("\r");
        await sawLine("RUNLOOP_MAXITERATIONS 1");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    // Negative control: the identical script, minus the /max-turns line — proves the override
    // above actually changed something, rather than the fake runLoop always printing the same
    // value regardless of what --max-turns was given.
    test("without a live override, the next turn's driveLoop call receives the --max-turns startup default", async () => {
      const scriptPath = join(dir, "child-max-turns-default.mjs");
      writeFileSync(scriptPath, childScriptMaxTurns(dir));

      const { child, sawLine } = startChild(scriptPath, dir);
      try {
        await sawLine("[approve-each]");

        // Same un-prefixed wait-then-submit shape as the positive case above.
        child.stdin?.write("do a task");
        await sawLine("do a task");
        child.stdin?.write("\r");
        await sawLine("RUNLOOP_MAXITERATIONS 5");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);
  });

  describe("/profile new", () => {
    test("creates the profile directory and confirms without switching the running session", async () => {
      const scriptPath = join(dir, "child-profile-new.mjs");
      writeFileSync(scriptPath, childScriptBare(dir));

      const { child, sawLine, sawLineTimes } = startChild(scriptPath, dir);
      try {
        await sawLine("[approve-each]");

        child.stdin?.write("/profile new work");
        await sawLine("/profile new work");
        child.stdin?.write("\r");
        await sawLine("Profile directory");
        // A short fragment, not the whole sentence: the full line wraps at Ink's 80-column
        // width between "does not" and "switch", so a longer substring straddling that wrap
        // would never appear on one rendered line and this would time out.
        await sawLine("switch the running session's profile");

        // waitForConfig's own reasoning, applied to a directory instead of a file: a bare
        // existsSync right after sawLine races the mkdirSync a DIFFERENT process (this test) is
        // reading, the same class of race macOS CI caught for config.json elsewhere in this file.
        const profileDir = join(dir, ".seri", "work");
        const deadline = Date.now() + 5000;
        while (!existsSync(profileDir) && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 20));
        expect(existsSync(profileDir)).toBe(true);

        // Round 3's own fix: `ensureOwnerOnlyDir`'s "did I create it" answer comes from mkdirSync's
        // own return value, not a separate existsSync probe beforehand — this is the "already
        // exists" branch of that answer, exercised by asking for the SAME name a second time.
        // sawLineTimes, not sawLine, for the typed-echo: "/profile new work" already appeared once
        // above, so a plain sawLine would resolve immediately against that first occurrence.
        child.stdin?.write("/profile new work");
        await sawLineTimes("/profile new work", 2);
        child.stdin?.write("\r");
        await sawLine("already exists");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("a path-traversal name renders a command-error and creates nothing", async () => {
      const scriptPath = join(dir, "child-profile-new-traversal.mjs");
      writeFileSync(scriptPath, childScriptBare(dir));

      const { child, sawLine } = startChild(scriptPath, dir);
      try {
        await sawLine("[approve-each]");

        child.stdin?.write("/profile new ../etc");
        await sawLine("/profile new ../etc");
        child.stdin?.write("\r");
        await sawLine("may only contain letters, numbers");

        await wait100ms();
        // The actual path a successful traversal would create: join(getBaseConfigDir(), "../etc")
        // NORMALIZES to a sibling of .seri, not something under it — so `.seri` not existing
        // proves nothing on its own (it would be equally absent whether or not the traversal was
        // blocked, since even an unblocked mkdirSync never targets a path under .seri here). This
        // is the primary assertion; `.seri` itself is also checked, but only as a secondary one.
        expect(existsSync(join(dir, "etc"))).toBe(false);
        expect(existsSync(join(dir, ".seri"))).toBe(false);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);
  });
});
