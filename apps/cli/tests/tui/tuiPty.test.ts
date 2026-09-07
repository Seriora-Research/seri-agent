import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelMessage } from "ai";
import { checkpointStoreDir } from "../../src/checkpoint/checkpoint";
import { isGitAvailable, resolveRef } from "../../src/checkpoint/shadowGit";
import { configDirForStore, DATABASE_FILENAME } from "../../src/session/database";
import { listSessionIds, loadSession, saveSession } from "../../src/session/session";
import { childScriptInput, SPLASH_MARK } from "./helpers";

function requireSessionId(sessionsDir: string): string {
  const id = listSessionIds(sessionsDir)[0];
  if (id === undefined) throw new Error("no session written yet");
  return id;
}

const exclusiveLocks = new Map<string, Database>();

function lockSessionStore(sessionsDir: string): void {
  // chmod does not fail writes on an already-open SQLite fd; an exclusive lock makes the child's next save SQLITE_BUSY.
  restoreSessionStore(sessionsDir);
  const path = join(configDirForStore(sessionsDir, "sessions"), DATABASE_FILENAME);
  const lock = new Database(path);
  lock.exec("PRAGMA busy_timeout = 0");
  // RUNLOOP_READY can race the child's first save; retry the lock until that commit finishes.
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      lock.exec("BEGIN EXCLUSIVE");
      exclusiveLocks.set(sessionsDir, lock);
      return;
    } catch (err) {
      const busy =
        err instanceof Error &&
        ((err as { code?: string }).code === "SQLITE_BUSY" || /locked/i.test(err.message));
      if (!busy || Date.now() >= deadline) {
        lock.close();
        throw err;
      }
      Bun.sleepSync(20);
    }
  }
}

function restoreSessionStore(sessionsDir: string): void {
  const lock = exclusiveLocks.get(sessionsDir);
  if (lock === undefined) return;
  exclusiveLocks.delete(sessionsDir);
  try {
    lock.exec("ROLLBACK");
  } catch {
    // already rolled back or connection closed
  }
  lock.close();
}

const CLI = pathToFileURL(join(import.meta.dir, "../../src/cli.ts")).href;
const SESSION_MODULE = pathToFileURL(join(import.meta.dir, "../../src/session/session.ts")).href;

// isTTY must come from a real pty; a fake true does not prove raw-mode input.
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

// 300 error events in one turn: tool-call no longer overflows the viewport until turn-end.
function childScriptManyLines(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  for (let i = 0; i < 300; i++) {`,
    `    yield { type: "error", error: "line-" + i + ".txt" };`,
    `  }`,
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

// Ink's is-in-ci treats a pty as non-interactive when CI=true, GitHub Actions' default.
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

function childScriptRejectsUndefined(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  throw undefined;`,
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

function childScriptErrorWithoutDone(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  yield { type: "error", error: "boom" };`,
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

// child.pid is the python3 pty allocator; the bun TUI pid is printed from the grandchild.
function childScriptSigterm(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `console.log("\\nPID=" + process.pid);`,
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

function childScriptMultiTurn(dir: string): string {
  return [
    // Redirect HOME so a persist cannot write the developer's ~/.seri.
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `let calls = 0;`,
    `async function* runLoopFake(opts) {`,
    `  calls++;`,
    `  console.log("\\nRUNLOOP_CALL " + calls + " messages=" + opts.messages.length);`,
    `  yield { type: "messages-updated", messages: [...opts.messages, { role: "assistant", content: "ok " + calls }] };`,
    // RUNLOOP_DONE is a one-shot console.log; a rendered done line is re-emitted on later OpenTUI/Ink repaints.
    `  console.log("\\nRUNLOOP_DONE " + calls);`,
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

function childScriptCancelledTurnContext(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `let calls = 0;`,
    `async function* runLoopFake(opts) {`,
    `  calls++;`,
    `  const roles = opts.messages.map((m) => m.role[0]).join("");`,
    `  const kept = opts.messages.some((m) => JSON.stringify(m.content).includes("task two"));`,
    `  console.log("\\nRUNLOOP_CALL " + calls + " roles=" + roles + " kept=" + kept);`,
    `  if (calls === 2) {`,
    `    console.log("\\nRUNLOOP_PARKED");`,
    `    await new Promise((resolve) => opts.signal.addEventListener("abort", resolve, { once: true }));`,
    `    console.log("\\nRUNLOOP_ABORTED");`,
    `    yield { type: "done", reason: "aborted" };`,
    `    return opts.messages;`,
    `  }`,
    `  yield { type: "messages-updated", messages: [...opts.messages, { role: "assistant", content: "ok " + calls }] };`,
    `  console.log("\\nRUNLOOP_DONE " + calls);`,
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

function childScriptAccountStatusOnce(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `process.env.SERI_DISABLE_MODELS_FETCH = "1";`,
    `process.env.SERI_GATEWAY_URL = "http://localhost:9999/api/gateway";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `const authStore = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "../../src/auth/authStore.ts")).href)});`,
    `const paths = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "../../src/config/paths.ts")).href)});`,
    `authStore.saveAuthSession(`,
    `  {`,
    `    accessToken: "at-1",`,
    `    refreshToken: "rt-1",`,
    `    userId: "user-1",`,
    `    email: "fake@example.com",`,
    `    obtainedAt: new Date().toISOString(),`,
    `  },`,
    `  paths.getConfigDir(),`,
    `);`,
    `let accountStatusCalls = 0;`,
    `const realFetch = globalThis.fetch;`,
    `globalThis.fetch = (url, opts) => {`,
    `  if (typeof url === "string" && url.includes("/account-status")) {`,
    `    accountStatusCalls++;`,
    `    console.log("\\nACCOUNT_STATUS_CALL " + accountStatusCalls);`,
    `    return Promise.resolve(new Response(JSON.stringify({ plan: "pro" }), { status: 200 }));`,
    `  }`,
    `  return realFetch(url, opts);`,
    `};`,
    `let calls = 0;`,
    `async function* runLoopFake(opts) {`,
    `  calls++;`,
    `  console.log("\\nRUNLOOP_CALL " + calls + " messages=" + opts.messages.length);`,
    `  yield { type: "messages-updated", messages: [...opts.messages, { role: "assistant", content: "ok " + calls }] };`,
    `  console.log("\\nRUNLOOP_DONE " + calls);`,
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

function childScriptPlanClearedOnLogout(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.SERI_DISABLE_MODELS_FETCH = "1";`,
    `process.env.SERI_GATEWAY_URL = "http://localhost:9999/api/gateway";`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `const authStore = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "../../src/auth/authStore.ts")).href)});`,
    `const paths = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "../../src/config/paths.ts")).href)});`,
    `authStore.saveAuthSession(`,
    `  {`,
    `    accessToken: "at-1",`,
    `    refreshToken: "rt-1",`,
    `    userId: "user-1",`,
    `    email: "fake@example.com",`,
    `    obtainedAt: new Date().toISOString(),`,
    `  },`,
    `  paths.getConfigDir(),`,
    `);`,
    `const realFetch = globalThis.fetch;`,
    `globalThis.fetch = (url, opts) => {`,
    `  if (typeof url === "string" && url.includes("/account-status")) {`,
    `    return Promise.resolve(new Response(JSON.stringify({ plan: "pro" }), { status: 200 }));`,
    `  }`,
    `  return realFetch(url, opts);`,
    `};`,
    `function logoutFake(configDir, onMessage) {`,
    `  authStore.clearAuthSession(configDir);`,
    `  (onMessage ?? console.log)("Logged out.");`,
    `}`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  await new Promise(() => {});`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  logout: logoutFake,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

function childScriptGatewayNoticeTui(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.SERI_DISABLE_MODELS_FETCH = "1";`,
    `process.env.SERI_GATEWAY_URL = "http://localhost:9999/api/gateway";`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `process.env.SERI_MODEL = "~openai/gpt-latest";`,
    `process.env.SERI_PROVIDER = "openrouter";`,
    `delete process.env.OPENROUTER_API_KEY;`,
    `delete process.env.ANTHROPIC_API_KEY;`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `const authStore = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "../../src/auth/authStore.ts")).href)});`,
    `const paths = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "../../src/config/paths.ts")).href)});`,
    `authStore.saveAuthSession(`,
    `  {`,
    `    accessToken: "at-1",`,
    `    refreshToken: "rt-1",`,
    `    userId: "user-1",`,
    `    email: "fake@example.com",`,
    `    obtainedAt: new Date().toISOString(),`,
    `  },`,
    `  paths.getConfigDir(),`,
    `);`,
    `const realFetch = globalThis.fetch;`,
    `globalThis.fetch = (url, opts) => {`,
    `  if (typeof url === "string" && url.includes("/account-status")) {`,
    `    return Promise.resolve(new Response(JSON.stringify({ plan: "pro" }), { status: 200 }));`,
    `  }`,
    `  return realFetch(url, opts);`,
    `};`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_CALL model=" + opts.model.id + " provider=" + opts.provider);`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  getGatewayModel: (id) => ({ id, via: "gateway" }),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

function childScriptModelSwitch(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `process.env.SERI_DISABLE_MODELS_FETCH = "1";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `let calls = 0;`,
    `async function* runLoopFake(opts) {`,
    `  calls++;`,
    `  const named = (opts.system.match(/You are powered by the model named ([^\\n]+)\\./) || [])[1];`,
    `  console.log("\\nRUNLOOP_CALL " + calls + " model=" + opts.model.id + " messages=" + opts.messages.length + " identity=" + named + " hasExactId=" + /exact model ID/i.test(opts.system));`,
    `  yield { type: "messages-updated", messages: [...opts.messages, { role: "assistant", content: "ok " + calls }] };`,
    `  console.log("\\nRUNLOOP_DONE " + calls);`,
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

// Delete SERI_DISABLE_MODELS_FETCH; the suite npm script sets it to 1 for the whole bun test process.
function childScriptEffortPersist(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `process.env.SERI_MODEL = "reasoning-model";`,
    `process.env.SERI_PROVIDER = "groq";`,
    `delete process.env.SERI_DISABLE_MODELS_FETCH;`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `const realFetch = globalThis.fetch;`,
    `globalThis.fetch = (url, opts) => {`,
    `  if (typeof url === "string" && url.includes("models.dev")) {`,
    `    return Promise.resolve(new Response(JSON.stringify({`,
    `      groq: { models: { "reasoning-model": { id: "reasoning-model", name: "Reasoning Model", family: "test", tool_call: true, reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }], limit: { context: 1000, output: 100 } } } },`,
    `      openrouter: { models: {} }, anthropic: { models: {} }, openai: { models: {} }, google: { models: {} },`,
    `    }), { status: 200 }));`,
    `  }`,
    `  return realFetch(url, opts);`,
    `};`,
    `let calls = 0;`,
    `async function* runLoopFake(opts) {`,
    `  calls++;`,
    `  console.log("\\nRUNLOOP_CALL " + calls + " reasoningEffort=" + opts.reasoningEffort);`,
    `  yield { type: "messages-updated", messages: [...opts.messages, { role: "assistant", content: "ok " + calls }] };`,
    `  console.log("\\nRUNLOOP_DONE " + calls);`,
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

function childScriptEffortDefaultAtMount(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `process.env.SERI_MODEL = "reasoning-model";`,
    `process.env.SERI_PROVIDER = "groq";`,
    `delete process.env.SERI_DISABLE_MODELS_FETCH;`,
    // resolveConfigValue is env-first; a shell-exported SERI_REASONING_EFFORT would override config.json.
    `delete process.env.SERI_REASONING_EFFORT;`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `const realFetch = globalThis.fetch;`,
    `globalThis.fetch = (url, opts) => {`,
    `  if (typeof url === "string" && url.includes("models.dev")) {`,
    `    return Promise.resolve(new Response(JSON.stringify({`,
    `      groq: { models: { "reasoning-model": { id: "reasoning-model", name: "Reasoning Model", family: "test", tool_call: true, reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }], limit: { context: 1000, output: 100 } } } },`,
    `      openrouter: { models: {} }, anthropic: { models: {} }, openai: { models: {} }, google: { models: {} },`,
    `    }), { status: 200 }));`,
    `  }`,
    `  return realFetch(url, opts);`,
    `};`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `const code = await cli.run([], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: (id) => ({ id }),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
    `console.log("\\nEXIT_CODE " + code);`,
  ].join("\n");
}

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
    `  console.log("\\nRUNLOOP_DONE " + calls);`,
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
    `  console.log("\\nRUNLOOP_DONE " + calls);`,
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

function childScriptModelSwitchMultiToolCall(dir: string): string {
  return [
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
    `    console.log("\\nRUNLOOP_DONE " + calls);`,
    `    yield { type: "done", reason: "no-tool-call" };`,
    `    return opts.messages;`,
    `  }`,
    `  yield { type: "messages-updated", messages: [...opts.messages, { role: "assistant", content: "ok " + calls }] };`,
    `  console.log("\\nRUNLOOP_DONE " + calls);`,
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

function childScriptModelSwitchFailure(dir: string): string {
  const sessionsDir = join(dir, "sessions");
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `const { loadSession, listSessionIds } = await import(${JSON.stringify(SESSION_MODULE)});`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `process.env.SERI_DISABLE_MODELS_FETCH = "1";`,
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
    `  const sessionId = listSessionIds(${JSON.stringify(sessionsDir)})[0];`,
    `  const onDisk = loadSession(sessionId, ${JSON.stringify(sessionsDir)});`,
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

function childScriptMultiTurnUsage(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `let calls = 0;`,
    `async function* runLoopFake(opts) {`,
    `  calls++;`,
    `  console.log("\\nRUNLOOP_CALL " + calls);`,
    `  yield { type: "usage", usage: { inputTokens: 10 * calls, outputTokens: 20 * calls } };`,
    `  console.log("\\nRUNLOOP_DONE " + calls);`,
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

function childScriptModePersistence(dir: string, flagPath: string): string {
  const sessionsDir = join(dir, "sessions");
  return [
    `import { existsSync } from "node:fs";`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `const { loadSession, listSessionIds } = await import(${JSON.stringify(SESSION_MODULE)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  yield { type: "messages-updated", messages: opts.messages };`,
    `  console.log("\\nRUNLOOP_MSG1");`,
    `  await new Promise((resolve) => {`,
    `    const check = () => { if (existsSync(${JSON.stringify(flagPath)})) resolve(); else setTimeout(check, 20); };`,
    `    check();`,
    `  });`,
    `  yield { type: "messages-updated", messages: opts.messages };`,
    `  const sessionId = listSessionIds(${JSON.stringify(sessionsDir)})[0];`,
    `  const modeAtResume = loadSession(sessionId, ${JSON.stringify(sessionsDir)}).permissionMode;`,
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

function childScriptSetup(dir: string, extraEnv: Record<string, string> = {}): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.SERI_DISABLE_MODELS_FETCH = "1";`,
    `process.env.SERI_SKIP_KEY_VALIDATION = "1";`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    ...Object.entries(extraEnv).map(
      ([name, value]) => `process.env.${name} = ${JSON.stringify(value)};`,
    ),
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

function childScriptLoggedInZeroKeys(dir: string): string {
  return [
    `process.env.HOME = ${JSON.stringify(dir)};`,
    `process.env.SERI_DISABLE_MODELS_FETCH = "1";`,
    `process.env.SERI_GATEWAY_URL = "http://localhost:9999/api/gateway";`,
    `delete process.env.GROQ_API_KEY;`,
    `delete process.env.OPENROUTER_API_KEY;`,
    `delete process.env.ANTHROPIC_API_KEY;`,
    `delete process.env.OPENAI_API_KEY;`,
    `delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;`,
    `delete process.env.XAI_API_KEY;`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `const realFetch = globalThis.fetch;`,
    `globalThis.fetch = (url, opts) => {`,
    `  if (typeof url === "string" && url.includes("/account-status")) {`,
    `    return Promise.resolve(new Response(JSON.stringify({ plan: "pro" }), { status: 200 }));`,
    `  }`,
    `  return realFetch(url, opts);`,
    `};`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `const code = await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGatewayModel: (id) => ({ id, via: "gateway" }),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
    `console.log("\\nEXIT_CODE " + code);`,
  ].join("\n");
}

function childScriptGuidedSetupSlowFetch(dir: string): string {
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

function childScriptGuidedSetupCatalogMissingProvider(dir: string): string {
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
    `    ? Promise.resolve(new Response(JSON.stringify({ groq: { models: {} } }), { status: 200 }))`,
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


function childScriptContinue(dir: string): string {
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
    `const code = await cli.run(["--continue"], {`,
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

function childScriptClear(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `let calls = 0;`,
    `async function* runLoopFake(opts) {`,
    `  calls++;`,
    `  console.log("\\nRUNLOOP_READY " + calls);`,
    `  await opts.tools.write_file.execute(`,
    `    { path: "note.txt", content: "turn " + calls },`,
    `    { toolCallId: "c" + calls, messages: opts.messages },`,
    `  );`,
    `  console.log("\\nWROTE " + calls);`,
    `  yield { type: "tool-call", name: "write_file", args: { path: "note.txt" } };`,
    `  yield { type: "tool-result", name: "write_file", result: "ok" };`,
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

function childScriptClearArchivist(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `let calls = 0;`,
    `async function* runLoopFake(opts) {`,
    `  calls++;`,
    `  console.log("\\nRUNLOOP_READY " + calls);`,
    `  const n = calls === 1 ? 9 : calls === 2 ? 1 : 9;`,
    `  for (let i = 0; i < n; i++) {`,
    `    yield { type: "tool-call", name: "read_file", args: { path: "x" + i + ".txt" } };`,
    `    yield { type: "tool-result", name: "read_file", result: "ok" };`,
    `  }`,
    `  console.log("\\nEMITTED " + calls + " " + n);`,
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
    `  authConfigDir: ${JSON.stringify(join(dir, "authconfig"))},`,
    `});`,
  ].join("\n");
}

type Exit = { code: number | null; signal: NodeJS.Signals | null; stdout: string };

// reconstructRows: OpenTUI cell-diff skips already-correct cells and only CUP-addressed text is on-grid; a raw .includes() misses a string split across writes.
function reconstructRows(raw: string): string[] {
  const rows: string[][] = [];
  function ensureCell(r: number, c: number): void {
    while (rows.length <= r) rows.push([]);
    while (rows[r].length <= c) rows[r].push(" ");
  }
  let row = 0;
  let col = 0;
  let armed = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "\x1b") {
      const marker = raw[i + 1];
      if (marker === "[") {
        let j = i + 2;
        while (j < raw.length && !/[\x40-\x7e]/.test(raw[j])) j++;
        const final = raw[j];
        if (final === "H" || final === "f") {
          const [r, c] = raw
            .slice(i + 2, j)
            .split(";")
            .map((n) => (n ? Number.parseInt(n, 10) : 1));
          row = Math.max(0, (r || 1) - 1);
          col = Math.max(0, (c || 1) - 1);
          armed = true;
        }
        i = j + 1;
        continue;
      }
      if (marker === "]" || marker === "P" || marker === "_" || marker === "^" || marker === "X") {
        let j = i + 2;
        while (j < raw.length && raw[j] !== "\x07" && !(raw[j] === "\x1b" && raw[j + 1] === "\\"))
          j++;
        i = raw[j] === "\x07" ? j + 1 : j + 2;
        continue;
      }
      i += 2; // a bare two-byte escape (ESC c, ESC =, ESC >, ...)
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      armed = false;
      i++;
      continue;
    }
    if (armed) {
      ensureCell(row, col);
      rows[row][col] = ch;
      col++;
    }
    i++;
  }
  return rows.map((r) => r.join(""));
}

// Count false→true row matches at each ESC[?2026l boundary; reconstructRows only holds the current cell, so a raw substring undercounts a split InputBox echo.
function countLogicalOccurrences(raw: string, line: string): number {
  const esu = "\x1b[?2026l";
  const frameEnds: number[] = [];
  for (let i = raw.indexOf(esu); i !== -1; i = raw.indexOf(esu, i + esu.length)) {
    frameEnds.push(i + esu.length);
  }
  frameEnds.push(raw.length);
  let count = 0;
  let wasMatching = new Set<number>();
  for (const end of frameEnds) {
    const rows = reconstructRows(raw.slice(0, end));
    const nowMatching = new Set<number>();
    rows.forEach((row, i) => {
      if (row.includes(line)) nowMatching.add(i);
    });
    for (const i of nowMatching) {
      if (!wasMatching.has(i)) count++;
    }
    wasMatching = nowMatching;
  }
  return count;
}

// python3 pty, not a pipe: raw mode needs 0x03 as a keypress and live character echo.
const PTY_RESIZE_SPAWN = 'stty rows "$1" cols "$2"; shift 2; exec "$@"';

// A pty with no winsize ioctl reports 80×24, OpenTUI's hardcoded fallback; PTY_RESIZE_SPAWN stty's before exec when a test needs a real size.
async function startChild(
  scriptPath: string,
  cwd: string,
  // dismissSplash defaults true: the welcome splash blocks RUNLOOP_READY on every interactive launch.
  opts: { dismissSplash?: boolean; terminalSize?: { cols: number; rows: number } } = {},
): Promise<{
  child: ReturnType<typeof spawn>;
  exited: Promise<Exit>;
  sawLine: (line: string) => Promise<void>;
  // sawLineTimes counts occurrences; sawLine is already true for turn 2's identical done line the instant turn 1 prints it.
  sawLineTimes: (line: string, count: number) => Promise<void>;
  // rawOccurrences is exact for one-shot console/escape bytes; transcript repaints re-emit the whole frame.
  rawOccurrences: (line: string) => number;
  // stdoutSoFar reads the live pty capture so SIGTERM can target the bun pid before exited.
  stdoutSoFar: () => string;
  // lastFrame is the current screen, not the cumulative byte stream.
  lastFrame: () => string;
  frameOccurrences: (line: string) => number;
  // Bounded poll, 20ms / 20s, same idiom as sawLine.
  sawInFrameTimes: (line: string, count: number) => Promise<void>;
}> {
  const target = opts.terminalSize
    ? [
        "sh",
        "-c",
        PTY_RESIZE_SPAWN,
        "sh",
        String(opts.terminalSize.rows),
        String(opts.terminalSize.cols),
        process.execPath,
        scriptPath,
      ]
    : [process.execPath, scriptPath];
  const args = ["-c", "import pty, sys; pty.spawn(sys.argv[1:])", ...target];
  // OTUI_USE_CONSOLE=false: TerminalConsoleCache otherwise swallows childScript console.log markers into a hidden overlay.
  const child = spawn("python3", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OTUI_USE_CONSOLE: "false" },
  });

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

  const rawOccurrences = (line: string): number => stdout.split(line).length - 1;

  const lastFrame = (): string => reconstructRows(stdout).join("\n");

  const frameOccurrences = (line: string): number => lastFrame().split(line).length - 1;

  // Cheap raw substring first; reconstructRows if OpenTUI cell-diff split the run.
  const gridContains = (line: string): boolean => {
    const rows = reconstructRows(stdout);
    if (rows.some((row) => row.includes(line))) return true;
    return rows.some((row, i) => {
      if (i + 1 >= rows.length) return false;
      const spaced = `${row.trimEnd()} ${rows[i + 1].trimStart()}`;
      const glued = `${row.trimEnd()}${rows[i + 1].trimStart()}`;
      return spaced.includes(line) || glued.includes(line);
    });
  };

  const seenLine = (line: string): boolean => stdout.includes(line) || gridContains(line);

  const sawLine = async (line: string): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (!seenLine(line) && spawnError === undefined && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    if (spawnError !== undefined)
      throw new Error(`could not spawn python3 (pty allocator): ${spawnError.message}`);
    if (!seenLine(line))
      throw new Error(`child never printed ${JSON.stringify(line)}; got ${JSON.stringify(stdout)}`);
  };

  const occurrences = (line: string): number =>
    Math.max(rawOccurrences(line), countLogicalOccurrences(stdout, line));

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

  const sawInFrameTimes = async (line: string, count: number): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (frameOccurrences(line) < count && spawnError === undefined && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    if (spawnError !== undefined)
      throw new Error(`could not spawn python3 (pty allocator): ${spawnError.message}`);
    if (frameOccurrences(line) < count)
      throw new Error(
        `frame contains ${JSON.stringify(line)} ${frameOccurrences(line)} time(s), wanted ${count}; got ${JSON.stringify(lastFrame())}`,
      );
  };

  // SPLASH_MARK is the earliest text the splash's first frame prints.
  if (opts.dismissSplash ?? true) {
    await sawLine(SPLASH_MARK);
    // The banner can paint before the menu that owns Escape.
    await sawLine("Esc continue");
    child.stdin?.write("\x1b");
    // sawLine is cumulative; the mode line can appear before splash dismiss.
    const dismissed = Date.now() + 20_000;
    let sawHint = false;
    let hintGone = false;
    let idlePolls = 0;
    const frameIsBlank = (frame: string): boolean =>
      !frame.split("\n").some((row) => row.trim().length > 0);
    while (spawnError === undefined && child.exitCode === null && Date.now() < dismissed) {
      const frame = lastFrame();
      if (gridContains("Esc continue")) sawHint = true;
      if (sawHint && !gridContains("Esc continue")) hintGone = true;
      if (hintGone && !frameIsBlank(frame)) {
        idlePolls++;
        if (idlePolls >= 2) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    if (spawnError !== undefined)
      throw new Error(`could not spawn python3 (pty allocator): ${spawnError.message}`);
    if (child.exitCode === null && idlePolls < 2)
      throw new Error(`splash never dismissed\n--- lastFrame ---\n${lastFrame()}`);
  }

  return {
    child,
    exited,
    sawLine,
    sawLineTimes,
    rawOccurrences,
    stdoutSoFar: () => stdout,
    lastFrame,
    frameOccurrences,
    sawInFrameTimes,
  };
}

type PtyChild = Awaited<ReturnType<typeof startChild>>;

// The picker header can paint, and sawLine("Route") resolve, before the filter input exists.
async function typePickerFilter(pty: PtyChild, text: string): Promise<void> {
  await pty.sawInFrameTimes("Type to filter", 1);
  pty.child.stdin?.write(text);
  const start = Date.now();
  const deadline = start + 20_000;
  let retried = false;
  while (Date.now() < deadline) {
    if (pty.lastFrame().includes(text) || pty.stdoutSoFar().includes(text)) return;
    if (!retried && Date.now() - start > 400 && pty.lastFrame().includes("Type to filter")) {
      pty.child.stdin?.write(text);
      retried = true;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `child never printed ${JSON.stringify(text)}; got ${JSON.stringify(pty.stdoutSoFar())}`,
  );
}

function childScriptQueue(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `let calls = 0;`,
    `async function* runLoopFake(opts) {`,
    `  calls++;`,
    `  const n = calls;`,
    `  const messages = [`,
    `    ...opts.messages,`,
    `    { role: "assistant", content: [{ type: "text", text: "working on turn " + n }] },`,
    `    { role: "user", content: [{ type: "text", text: "rules for turn " + n }] },`,
    `  ];`,
    `  yield { type: "messages-updated", messages };`,
    `  console.log("\\nRUNLOOP_CALL " + n);`,
    `  await new Promise((resolve) => opts.signal.addEventListener("abort", resolve, { once: true }));`,
    `  console.log("\\nRUNLOOP_ABORTED " + n);`,
    `  yield { type: "done", reason: "aborted" };`,
    `  return messages;`,
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

// Windows has no pty to allocate.
describe.skipIf(process.platform === "win32")("the Ink TUI on a real terminal", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seri-pty-tui-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // waitForConfig polls parsed content: WSL/macOS CI can show a stdout line before another process sees the new config.json, and existence alone matches stale seedConfig.
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

  test("a single Ctrl-C during an Ink-driven run cancels the turn instead of killing the process outright", async () => {
    const scriptPath = join(dir, "child-cancel.mjs");
    writeFileSync(scriptPath, childScriptCancel(dir));

    const { child, sawLine, frameOccurrences, sawInFrameTimes } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      await sawInFrameTimes("> do a task", 1);
      expect(frameOccurrences("> do a task")).toBe(1);
      child.stdin?.write("\x03");
      // Leave stdin open; EOF would end the run.
      await sawLine("RUNLOOP_ABORTED aborted=true");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("typing a slash command into the input box, then Enter, dispatches it through the Phase 5 wiring", async () => {
    const scriptPath = join(dir, "child-input.mjs");
    writeFileSync(scriptPath, childScriptInput(dir));

    const { child, sawLine, frameOccurrences, sawInFrameTimes } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");

      child.stdin?.write("/mode");
      await sawLine("/mode");

      child.stdin?.write("\r");
      await sawLine("permission mode is now auto");
      await sawInFrameTimes("> /mode", 1);
      expect(frameOccurrences("> /mode")).toBe(1);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("shift+tab and /mode share one source of truth, keeping liveState in step with the indicator", async () => {
    const scriptPath = join(dir, "child-input.mjs");
    writeFileSync(scriptPath, childScriptInput(dir));

    const { child, sawLine } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      await sawLine("approve-each mode on");

      child.stdin?.write("\x1b[Z");
      await sawLine("bypass permissions on");

      child.stdin?.write("/mode");
      await sawLine("/mode");
      child.stdin?.write("\r");
      await sawLine("permission mode is now read-only");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("shift+tab shows an error instead of crashing the TUI when its own persist fails", async () => {
    const scriptPath = join(dir, "child-input-cycle-persist-failure.mjs");
    writeFileSync(scriptPath, childScriptInput(dir));

    const sessionsDir = join(dir, "sessions");
    const { child, sawLine } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      await sawLine("approve-each mode on");

      lockSessionStore(sessionsDir);

      child.stdin?.write("\x1b[Z");
      await sawLine("could not save the session");

      restoreSessionStore(sessionsDir);

      child.stdin?.write("/mode");
      await sawLine("/mode");
      child.stdin?.write("\r");
      await sawLine("permission mode is now");
    } finally {
      restoreSessionStore(sessionsDir);
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("a slash command that throws, or one that matches nothing, shows an error line instead of crashing the TUI", async () => {
    const scriptPath = join(dir, "child-command-error.mjs");
    writeFileSync(scriptPath, childScriptCommandError(dir));

    const { child, sawLine } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      await sawLine("done ·");

      child.stdin?.write("/mdoe");
      await sawLine("/mdoe");
      child.stdin?.write("\r");
      await sawLine("Unrecognized command: /mdoe");

      child.stdin?.write("/undo 5");
      await sawLine("/undo 5");
      child.stdin?.write("\r");
      await sawLine("checkpoint(s) to undo to; asked for 5");

      child.stdin?.write("/mode");
      await sawLine("/mode");
      child.stdin?.write("\r");
      await sawLine("permission mode is now auto");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("/exit with trailing arguments is rejected rather than quitting the TUI", async () => {
    const scriptPath = join(dir, "child-exit-hijack.mjs");
    writeFileSync(scriptPath, childScriptCommandError(dir));

    const { child, sawLine } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      await sawLine("done ·");

      child.stdin?.write("/exit the debugger and retry");
      await sawLine("/exit the debugger and retry");
      child.stdin?.write("\r");
      await sawLine("/exit: invalid arguments.");

      child.stdin?.write("/mode");
      await sawLine("/mode");
      child.stdin?.write("\r");
      await sawLine("permission mode is now auto");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("driveLoop rejecting settles run() instead of hanging forever", async () => {
    const scriptPath = join(dir, "child-rejects.mjs");
    writeFileSync(scriptPath, childScriptRejects(dir));

    const { exited, sawLine } = await startChild(scriptPath, dir);
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
    }
  }, 60_000);

  test("driveLoop rejecting with a bare `undefined` reason also settles run() instead of hanging", async () => {
    const scriptPath = join(dir, "child-rejects-undefined.mjs");
    writeFileSync(scriptPath, childScriptRejectsUndefined(dir));

    const { child, exited, sawLine } = await startChild(scriptPath, dir);
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
      child.kill("SIGKILL");
      await exited;
    }
  }, 60_000);

  test("a turn that ends via error-without-done clears the elapsed-time indicator", async () => {
    const scriptPath = join(dir, "child-error-no-done.mjs");
    writeFileSync(scriptPath, childScriptErrorWithoutDone(dir));

    const { child, sawLine, lastFrame } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      await sawLine("boom");

      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(lastFrame()).not.toMatch(/\b\d+s\b/);

      child.stdin?.write("/mode");
      await sawLine("/mode");
      child.stdin?.write("\r");
      await sawLine("permission mode is now auto");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("a second, free-form task submission starts another turn against the accumulated session", async () => {
    const scriptPath = join(dir, "child-multi-turn.mjs");
    writeFileSync(scriptPath, childScriptMultiTurn(dir));

    const { child, sawLine, frameOccurrences, sawInFrameTimes } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_CALL 1 messages=1");
      await sawLine("done ·");

      child.stdin?.write("a second task");
      await sawLine("a second task");
      child.stdin?.write("\r");

      await sawLine("RUNLOOP_CALL 2 messages=3");
      await sawInFrameTimes("> a second task", 1);
      expect(frameOccurrences("> a second task")).toBe(1);

      await sawLine("RUNLOOP_DONE 2");
      expect(existsSync(join(dir, ".seri", "config.json"))).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("a cancelled turn leaves its own prompt in the session the next turn is built from", async () => {
    const scriptPath = join(dir, "child-cancelled-turn-context.mjs");
    writeFileSync(scriptPath, childScriptCancelledTurnContext(dir));

    const { child, sawLine } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_CALL 1 roles=u kept=false");
      await sawLine("RUNLOOP_DONE 1");

      child.stdin?.write("task two");
      await sawLine("task two");
      child.stdin?.write("\r");
      await sawLine("RUNLOOP_CALL 2 roles=uau kept=true");
      await sawLine("RUNLOOP_PARKED");

      child.stdin?.write("\x03");
      await sawLine("RUNLOOP_ABORTED");
      await sawLine("done: aborted");

      child.stdin?.write("task three");
      await sawLine("task three");
      child.stdin?.write("\r");
      await sawLine("RUNLOOP_CALL 3 roles=uauau kept=true");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("a logged-in session's account-status fetch happens once at session start, reused across turns", async () => {
    const scriptPath = join(dir, "child-account-status-once.mjs");
    writeFileSync(scriptPath, childScriptAccountStatusOnce(dir));

    const { child, sawLine, rawOccurrences } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_CALL 1 messages=1");
      await sawLine("RUNLOOP_DONE 1");
      expect(rawOccurrences("ACCOUNT_STATUS_CALL")).toBe(1);

      child.stdin?.write("a second task");
      await sawLine("a second task");
      child.stdin?.write("\r");

      await sawLine("RUNLOOP_CALL 2 messages=3");
      await sawLine("RUNLOOP_DONE 2");
      expect(rawOccurrences("ACCOUNT_STATUS_CALL")).toBe(1);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("a real /logout clears the cached plan: a gateway-covered picker row drops back to 'no key'", async () => {
    const scriptPath = join(dir, "child-plan-cleared-on-logout.mjs");
    writeFileSync(scriptPath, childScriptPlanClearedOnLogout(dir));

    const pty = await startChild(scriptPath, dir);
    const { child, sawLine, sawInFrameTimes, lastFrame } = pty;
    try {
      await sawLine("RUNLOOP_READY");

      child.stdin?.write("/model");
      await sawLine("/model");
      child.stdin?.write("\r");
      await sawLine("GPT OSS 120B");

      child.stdin?.write("gpt-latest");
      await sawInFrameTimes("gpt-latest", 1);
      expect(lastFrame()).toContain("seri");

      child.stdin?.write("\x1b"); // Escape: cancels the picker without selecting
      await new Promise((resolve) => setTimeout(resolve, 100));

      child.stdin?.write("/logout");
      await sawLine("/logout");
      child.stdin?.write("\r");
      await sawLine("Logged out.");

      child.stdin?.write("/model");
      await sawLine("/model");
      child.stdin?.write("\r");
      await typePickerFilter(pty, "gpt-latest");
      await sawInFrameTimes("no key", 1);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("a live turn served through the gateway does not append a same-route routing line", async () => {
    const scriptPath = join(dir, "child-gateway-notice.mjs");
    writeFileSync(scriptPath, childScriptGatewayNoticeTui(dir));

    const { child, sawLine, rawOccurrences } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_CALL model=~openai/gpt-latest provider=openrouter");
      await sawLine("done ·");

      expect(rawOccurrences("↻ routing")).toBe(0);
      expect(rawOccurrences("on your seri plan")).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("switching the model via /model re-resolves the model on the very next turn without touching accumulated messages", async () => {
    const scriptPath = join(dir, "child-model-switch.mjs");
    writeFileSync(scriptPath, childScriptModelSwitch(dir));

    const pty = await startChild(scriptPath, dir);
    const { child, sawLine } = pty;
    try {
      await sawLine(
        "RUNLOOP_CALL 1 model=openai/gpt-oss-120b messages=1 identity=GPT OSS 120B hasExactId=false",
      );
      await sawLine("done ·");

      child.stdin?.write("/model");
      await sawLine("/model");
      child.stdin?.write("\r");
      await typePickerFilter(pty, "70b-versatile");
      child.stdin?.write("\r");
      // 100ms after a keypress that unmounts a panel; the next InputBox is not yet the focused tty.
      await new Promise((resolve) => setTimeout(resolve, 100));

      child.stdin?.write("a second task");
      await sawLine("a second task");
      child.stdin?.write("\r");

      await sawLine(
        "RUNLOOP_CALL 2 model=llama-3.3-70b-versatile messages=3 identity=Llama 3.3 70B hasExactId=false",
      );

      await sawLine("RUNLOOP_DONE 2");
      const config = await waitForConfig(
        join(dir, ".seri", "config.json"),
        (c) => c.SERI_MODEL === "llama-3.3-70b-versatile",
      );
      expect(config.SERI_MODEL).toBe("llama-3.3-70b-versatile");
      expect(config.SERI_PROVIDER).toBe("groq");
      expect(config.SERI_MODEL).not.toBe("openai/gpt-oss-120b");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("/effort <level> mid-session persists as the config default once the turn that used it succeeds", async () => {
    const scriptPath = join(dir, "child-effort-persist.mjs");
    writeFileSync(scriptPath, childScriptEffortPersist(dir));

    const { child, sawLine } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_CALL 1 reasoningEffort=undefined");
      await sawLine("RUNLOOP_DONE 1");
      expect(existsSync(join(dir, ".seri", "config.json"))).toBe(false);

      child.stdin?.write("/effort medium");
      await sawLine("/effort medium");
      child.stdin?.write("\r");
      await sawLine("Reasoning effort: medium");
      await new Promise((resolve) => setTimeout(resolve, 100));

      child.stdin?.write("a second task");
      await sawLine("a second task");
      child.stdin?.write("\r");

      await sawLine("RUNLOOP_CALL 2 reasoningEffort=medium");
      await sawLine("RUNLOOP_DONE 2");

      const config = await waitForConfig(
        join(dir, ".seri", "config.json"),
        (c) => c.SERI_REASONING_EFFORT === "medium",
      );
      expect(config.SERI_REASONING_EFFORT).toBe("medium");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("/config changing SERI_REASONING_EFFORT mid-session does not block a later /effort persist", async () => {
    seedConfig(dir, { SERI_REASONING_EFFORT: "medium" });

    const scriptPath = join(dir, "child-effort-config-bypass.mjs");
    writeFileSync(scriptPath, childScriptEffortPersist(dir));

    const { child, sawLine } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_CALL 1 reasoningEffort=medium");
      await sawLine("RUNLOOP_DONE 1");

      child.stdin?.write("/config");
      await sawLine("/config");
      child.stdin?.write("\r");
      await wait100ms();
      await sawLine("/config — settings");
      child.stdin?.write("\x1b[B");
      await wait100ms();
      child.stdin?.write("\x1b[B");
      await wait100ms();
      child.stdin?.write("a");
      await wait100ms();
      await sawLine("Set Reasoning effort (SERI_REASONING_EFFORT)");

      child.stdin?.write("low");
      await wait100ms();
      child.stdin?.write("\r");
      await sawLine("Saved SERI_REASONING_EFFORT.");

      const bypassed = await waitForConfig(
        join(dir, ".seri", "config.json"),
        (c) => c.SERI_REASONING_EFFORT === "low",
      );
      expect(bypassed.SERI_REASONING_EFFORT).toBe("low");

      child.stdin?.write("\x1b");
      await new Promise((resolve) => setTimeout(resolve, 30));
      await wait100ms();

      child.stdin?.write("/effort medium");
      await sawLine("/effort medium");
      child.stdin?.write("\r");
      await sawLine("Reasoning effort: medium");
      await new Promise((resolve) => setTimeout(resolve, 100));

      child.stdin?.write("a second task");
      await sawLine("a second task");
      child.stdin?.write("\r");

      await sawLine("RUNLOOP_CALL 2 reasoningEffort=medium");
      await sawLine("RUNLOOP_DONE 2");

      const config = await waitForConfig(
        join(dir, ".seri", "config.json"),
        (c) => c.SERI_REASONING_EFFORT === "medium",
      );
      expect(config.SERI_REASONING_EFFORT).toBe("medium");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("a value the persist-on-success gate just wrote reaches the header on /effort auto, with no turn in between", async () => {
    seedConfig(dir, { SERI_REASONING_EFFORT: "low" });

    const scriptPath = join(dir, "child-effort-persist-header.mjs");
    writeFileSync(scriptPath, childScriptEffortPersist(dir));

    const { child, sawLine, sawInFrameTimes, lastFrame } = await startChild(scriptPath, dir, {
      terminalSize: { cols: 100, rows: 30 },
    });
    try {
      await sawLine("RUNLOOP_CALL 1 reasoningEffort=low");
      await sawLine("RUNLOOP_DONE 1");
      await sawLine("reasoning-model · groq · low");

      child.stdin?.write("/effort high");
      await sawLine("/effort high");
      child.stdin?.write("\r");
      await sawLine("Reasoning effort: high");

      child.stdin?.write("a second task");
      await sawLine("a second task");
      child.stdin?.write("\r");
      await sawLine("RUNLOOP_CALL 2 reasoningEffort=high");
      await sawLine("RUNLOOP_DONE 2");

      await waitForConfig(
        join(dir, ".seri", "config.json"),
        (c) => c.SERI_REASONING_EFFORT === "high",
      );

      child.stdin?.write("/effort auto");
      await sawLine("/effort auto");
      child.stdin?.write("\r");
      await sawLine("Reasoning effort: auto (falls back to the config default).");

      await sawInFrameTimes("Reasoning effort: auto (falls back to the config default).", 1);
      expect(lastFrame()).toContain("reasoning-model · groq · high");
      expect(lastFrame()).not.toContain("· low");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("/model shows every route to a multi-route model, and picking one persists that specific provider", async () => {
    const scriptPath = join(dir, "child-model-multiroute.mjs");
    writeFileSync(scriptPath, childScriptModelMultiRoute(dir));

    const pty = await startChild(scriptPath, dir);
    const { child, sawLine } = pty;
    try {
      await sawLine("RUNLOOP_CALL 1 model=openai/gpt-oss-120b provider=groq");
      await sawLine("done ·");

      child.stdin?.write("/model");
      await sawLine("/model");
      child.stdin?.write("\r");

      await typePickerFilter(pty, "claude-sonnet-5");
      await pty.sawInFrameTimes("Claude Sonnet 5", 2);
      await pty.sawInFrameTimes("no key", 2);

      child.stdin?.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 100));

      child.stdin?.write("a second task");
      await sawLine("a second task");
      child.stdin?.write("\r");

      await sawLine("RUNLOOP_CALL 2 model=claude-sonnet-5 provider=anthropic");
      await sawLine("RUNLOOP_DONE 2");

      const config = await waitForConfig(
        join(dir, ".seri", "config.json"),
        (c) => c.SERI_MODEL === "claude-sonnet-5",
      );
      expect(config.SERI_MODEL).toBe("claude-sonnet-5");
      expect(config.SERI_PROVIDER).toBe("anthropic");
      expect(config.SERI_PROVIDER).not.toBe("openrouter");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("a live /model pick to a route that itself reroutes persists the RESOLVED provider, not the one literally picked (D4)", async () => {
    const scriptPath = join(dir, "child-model-pick-rerouted.mjs");
    writeFileSync(scriptPath, childScriptModelPickRerouted(dir));

    const { child, sawLine } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_CALL 1 model=openai/gpt-oss-120b provider=groq");
      await sawLine("done ·");

      expect(existsSync(join(dir, ".seri", "config.json"))).toBe(false);

      child.stdin?.write("/model");
      await sawLine("/model");
      child.stdin?.write("\r");
      await sawLine("Route");

      child.stdin?.write("claude-sonnet-5 openrouter");
      await sawLine("claude-sonnet-5 openrouter");
      child.stdin?.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 100));

      child.stdin?.write("a second task");
      await sawLine("a second task");
      child.stdin?.write("\r");

      await sawLine("RUNLOOP_CALL 2 model=claude-sonnet-5 provider=anthropic");
      // Split across two checks: on a real pty (WSL) one long toContain/sawLine was not stable.
      const noticePrefix = "↻ routing claude-sonnet-5 via anthropic (your key) — no OpenRouter key";
      await sawLine(noticePrefix);
      await sawLine("configured");
      await sawLine("RUNLOOP_DONE 2");
      const config = await waitForConfig(
        join(dir, ".seri", "config.json"),
        (c) => c.SERI_MODEL === "claude-sonnet-5",
      );
      expect(config.SERI_MODEL).toBe("claude-sonnet-5");
      expect(config.SERI_PROVIDER).toBe("anthropic");
      expect(config.SERI_PROVIDER).not.toBe("openrouter");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("a failed default-model persist is retried by a later turn on the same model", async () => {
    const scriptPath = join(dir, "child-model-switch-persist-retry.mjs");
    writeFileSync(scriptPath, childScriptModelSwitch(dir));

    const pty = await startChild(scriptPath, dir);
    const { child, sawLine } = pty;
    try {
      await sawLine(
        "RUNLOOP_CALL 1 model=openai/gpt-oss-120b messages=1 identity=GPT OSS 120B hasExactId=false",
      );
      await sawLine("done ·");

      const configDir = join(dir, ".seri");
      mkdirSync(configDir, { recursive: true });
      chmodSync(configDir, 0o500);

      child.stdin?.write("/model");
      await sawLine("/model");
      child.stdin?.write("\r");
      await typePickerFilter(pty, "70b-versatile");
      child.stdin?.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 100));

      child.stdin?.write("a second task");
      await sawLine("a second task");
      child.stdin?.write("\r");

      await sawLine(
        "RUNLOOP_CALL 2 model=llama-3.3-70b-versatile messages=3 identity=Llama 3.3 70B hasExactId=false",
      );
      await sawLine("could not save the default model:");
      expect(existsSync(join(configDir, "config.json"))).toBe(false);

      chmodSync(configDir, 0o700);

      child.stdin?.write("a third task");
      await sawLine("a third task");
      child.stdin?.write("\r");

      await sawLine(
        "RUNLOOP_CALL 3 model=llama-3.3-70b-versatile messages=5 identity=Llama 3.3 70B hasExactId=false",
      );
      await sawLine("RUNLOOP_DONE 3");
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

  test("a persistently failing persist is attempted once per turn, not once per tool call", async () => {
    const scriptPath = join(dir, "child-model-switch-multi-tool-call.mjs");
    writeFileSync(scriptPath, childScriptModelSwitchMultiToolCall(dir));

    const { child, sawLine, rawOccurrences } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_CALL 1 model=openai/gpt-oss-120b");
      await sawLine("done ·");

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
      await sawLine("RUNLOOP_DONE 2");

      await sawLine("could not save the default model:");
      expect(rawOccurrences("could not save the default model:")).toBe(1);
      expect(existsSync(join(configDir, "config.json"))).toBe(false);
    } finally {
      try {
        chmodSync(join(dir, ".seri"), 0o700);
      } catch {}
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("a /model switch whose first turn fails is not persisted — the on-disk session keeps the model that last worked", async () => {
    const scriptPath = join(dir, "child-model-switch-failure.mjs");
    writeFileSync(scriptPath, childScriptModelSwitchFailure(dir));

    const { child, sawLine } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_CALL 1 model=openai/gpt-oss-120b");
      await sawLine("done ·");

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
      await sawLine("MODEL_ON_DISK_AFTER_FAILURE openai/gpt-oss-120b");

      expect(existsSync(join(dir, ".seri", "config.json"))).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("a /model pick to a keyless provider that fails never persists that provider as confirmed", async () => {
    const scriptPath = join(dir, "child-model-pick-keyless.mjs");
    writeFileSync(scriptPath, childScriptModelPickKeyless(dir));
    const sessionsDir = join(dir, "sessions");

    const pty = await startChild(scriptPath, dir);
    const { child, sawLine } = pty;
    try {
      await sawLine("RUNLOOP_CALL 1 model=openai/gpt-oss-120b");
      await sawLine("done ·");

      child.stdin?.write("/model");
      await sawLine("/model");
      child.stdin?.write("\r");
      await sawLine("GPT OSS 120B");

      await typePickerFilter(pty, "claude-sonnet-5");
      await pty.sawInFrameTimes("no key", 1);
      child.stdin?.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 100));

      child.stdin?.write("a second task");
      await sawLine("a second task");
      child.stdin?.write("\r");

      await sawLine("No Anthropic key configured. Run /setup to add one.");

      const sessionId = requireSessionId(sessionsDir);

      const deadline = Date.now() + 5_000;
      let onDisk: { provider?: string };
      do {
        onDisk = loadSession(sessionId, sessionsDir);
      } while (onDisk.provider === undefined && Date.now() < deadline);
      if (onDisk.provider === undefined) throw new Error("no provider persisted yet");

      expect(onDisk.provider).toBe("groq");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("a second Ctrl-C after the first is spent terminates the process instead of hanging", async () => {
    const scriptPath = join(dir, "child-cancel.mjs");
    writeFileSync(scriptPath, childScriptCancel(dir));

    const { child, exited, sawLine } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      child.stdin?.write("\x03");
      await sawLine("RUNLOOP_ABORTED aborted=true");
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

  test("submitting /exit after a turn completes resolves run() with a normal exit code and a final usage summary", async () => {
    const scriptPath = join(dir, "child-quit.mjs");
    writeFileSync(scriptPath, childScriptQuit(dir));

    const { child, exited, sawLine } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      await sawLine("done ·");

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
      const { stdout } = result as Exit;
      expect(stdout).toContain("EXIT_CODE 0");
      expect(stdout).toContain("(tokens: 12 in, 34 out)");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("Ctrl-D at the input box quits the same way /exit does", async () => {
    const scriptPath = join(dir, "child-quit-ctrld.mjs");
    writeFileSync(scriptPath, childScriptQuit(dir));

    const { child, exited, sawLine } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      await sawLine("done ·");

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
      expect(stdout).toContain("(tokens: 12 in, 34 out)");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("submitting /exit while a turn is in flight cancels it gracefully instead of abandoning it (HIGH-B)", async () => {
    const scriptPath = join(dir, "child-quit-mid-turn.mjs");
    writeFileSync(scriptPath, childScriptQuitMidTurn(dir));

    const { child, exited, sawLine } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");

      child.stdin?.write("/exit");
      await sawLine("/exit");
      child.stdin?.write("\r");

      await sawLine("quitting — cancelling the in-flight turn, Ctrl-C to force");

      await sawLine("RUNLOOP_ABORTED aborted=true");

      const result = await Promise.race([
        exited,
        new Promise<"the run never settled">((r) =>
          setTimeout(() => r("the run never settled"), 15_000),
        ),
      ]);

      expect(result).not.toBe("the run never settled");
      const { stdout } = result as Exit;
      expect(stdout).toContain("EXIT_CODE 1");
      expect(stdout).toContain("(tokens: 12 in, 34 out)");

      const sessionsDir = join(dir, "sessions");
      const sessionId = requireSessionId(sessionsDir);
      const onDisk = loadSession(sessionId, sessionsDir);
      expect(onDisk.id).toBe(sessionId);
      expect(Array.isArray(onDisk.messages)).toBe(true);
      expect(onDisk.messages.length).toBeGreaterThan(0);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("a multi-turn session's final usage summary sums every turn's tokens, not just the last one", async () => {
    const scriptPath = join(dir, "child-multi-turn-usage.mjs");
    writeFileSync(scriptPath, childScriptMultiTurnUsage(dir));

    const { child, exited, sawLine } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_CALL 1");
      await sawLine("done ·");

      child.stdin?.write("a second task");
      await sawLine("a second task");
      child.stdin?.write("\r");
      await sawLine("RUNLOOP_CALL 2");
      await sawLine("RUNLOOP_DONE 2");
      await wait100ms();

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
      const { stdout } = result as Exit;
      expect(stdout).toContain("EXIT_CODE 0");
      // Turn 1 is 10 in / 20 out; turn 2 is 20 in / 40 out; the summary must be 30 / 60.
      expect(stdout).toContain("(tokens: 30 in, 60 out)");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("/rewind is blocked while a turn is in flight, but /mode still works (MEDIUM-3)", async () => {
    const scriptPath = join(dir, "child-turn-in-flight-gate.mjs");
    writeFileSync(scriptPath, childScriptInput(dir));

    const { child, sawLine } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");

      child.stdin?.write("/rewind 1");
      await sawLine("/rewind 1");
      child.stdin?.write("\r");
      await sawLine("/rewind: can't run while a turn is in flight.");

      child.stdin?.write("/mode");
      await sawLine("/mode");
      child.stdin?.write("\r");
      await sawLine("permission mode is now auto");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("a submission rejected by the turnInFlight gate is echoed without fragmenting the model's in-progress answer", async () => {
    const flagPath = join(dir, "release-turn");
    const scriptPath = join(dir, "child-rewind-during-stream.mjs");
    writeFileSync(scriptPath, childScriptRewindDuringStream(dir, flagPath));

    const { child, sawLine, frameOccurrences, sawInFrameTimes } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      await sawLine("STREAM_PART_1");

      child.stdin?.write("/rewind 1");
      await sawLine("/rewind 1");
      child.stdin?.write("\r");
      await sawLine("/rewind: can't run while a turn is in flight.");

      writeFileSync(flagPath, "");
      await sawLine("done ·");
      await sawInFrameTimes("Hello world", 1);

      expect(frameOccurrences("Hello world")).toBe(1);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("a mid-turn /mode change is on disk before the turn's next write, and that write does not revert it", async () => {
    const flagPath = join(dir, "release-turn");
    const scriptPath = join(dir, "child-mode-persist.mjs");
    writeFileSync(scriptPath, childScriptModePersistence(dir, flagPath));
    const sessionsDir = join(dir, "sessions");

    const { child, sawLine } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      await sawLine("RUNLOOP_MSG1");

      child.stdin?.write("/mode");
      await sawLine("/mode");
      child.stdin?.write("\r");
      await sawLine("permission mode is now auto");

      const sessionId = requireSessionId(sessionsDir);

      const deadline = Date.now() + 5_000;
      let mode: string;
      do {
        mode = loadSession(sessionId, sessionsDir).permissionMode;
      } while (mode !== "auto" && Date.now() < deadline);
      expect(mode).toBe("auto");

      writeFileSync(flagPath, "");
      await sawLine("MODE_AT_RESUME auto");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("a session-save failure surfaces as a command error instead of hanging forever (finding 1)", async () => {
    const scriptPath = join(dir, "child-save-failure.mjs");
    writeFileSync(scriptPath, childScriptInput(dir));
    const sessionsDir = join(dir, "sessions");

    const { child, sawLine, sawLineTimes } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");

      lockSessionStore(sessionsDir);

      child.stdin?.write("/mode");
      await sawLine("/mode");
      child.stdin?.write("\r");
      await sawLine("could not save the session");

      restoreSessionStore(sessionsDir);
      child.stdin?.write("/mode");
      await sawLineTimes("/mode", 2);
      child.stdin?.write("\r");
      await sawLine("permission mode is now");
    } finally {
      restoreSessionStore(sessionsDir);
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("the TUI still renders and responds to input when CI=true is set (the GitHub Actions default)", async () => {
    const scriptPath = join(dir, "child-ci-env.mjs");
    writeFileSync(scriptPath, childScriptCiEnv(dir));

    const { child, sawLine } = await startChild(scriptPath, dir);
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

  test("a write-tool approval prompt renders in the TUI and a keypress unblocks the turn", async () => {
    const scriptPath = join(dir, "child-approval.mjs");
    writeFileSync(scriptPath, childScriptApproval(dir));

    const { child, sawLine } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      await sawLine(`Write a.txt?`);
      await sawLine("[N]o");

      child.stdin?.write("y");
      await sawLine("PROMPT_ANSWER once");

      await sawLine("done ·");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("a routing-priority reroute active from session start takes effect on turn 1 and announces itself once, without touching config.json", async () => {
    const scriptPath = join(dir, "child-reroute.mjs");
    writeFileSync(scriptPath, childScriptReroute(dir));

    const { child, sawLine, frameOccurrences, rawOccurrences } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_CALL 1 via=anthropic provider=anthropic");
      const noticePrefix = "↻ routing claude-sonnet-5 via anthropic (your key) — no OpenRouter key";
      await sawLine(noticePrefix);
      await sawLine("configured");
      await sawLine("done ·");

      expect(frameOccurrences(noticePrefix)).toBe(1);

      expect(rawOccurrences("⚠ routing")).toBe(0);

      expect(existsSync(join(dir, ".seri", "config.json"))).toBe(false);

      const sessionsDir = join(dir, "sessions");
      const sessionId = requireSessionId(sessionsDir);
      const deadline = Date.now() + 5_000;
      let onDisk: { provider?: string };
      do {
        onDisk = loadSession(sessionId, sessionsDir);
      } while (onDisk.provider === undefined && Date.now() < deadline);
      expect(onDisk.provider).toBe("anthropic");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("an explicit pick with its own key stays on that provider and never prints a reroute notice", async () => {
    const scriptPath = join(dir, "child-no-reroute.mjs");
    writeFileSync(scriptPath, childScriptNoReroute(dir));

    const { child, sawLine, rawOccurrences } = await startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_CALL 1 via=or provider=openrouter");
      await sawLine("done ·");

      expect(rawOccurrences("↻ routing")).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  function seedConfig(target: string, values: Record<string, string>): void {
    const configDir = join(target, ".seri");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify(values));
  }

  function wait100ms(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 100));
  }

  describe("/setup", () => {
    test("lists every BYOK provider with correct source, masked values, and disabled removal for an env row", async () => {
      seedConfig(dir, { ANTHROPIC_API_KEY: "sk-ant-fake-config-key-abcdefgh" });
      const scriptPath = join(dir, "child-setup-list.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      // 100 columns, not the default 80: this assertion is about listed rows, not leftover packing.
      const { child, sawLine, rawOccurrences } = await startChild(scriptPath, dir, {
        terminalSize: { cols: 100, rows: 30 },
      });
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/setup");
        await sawLine("/setup");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("/setup — provider API keys");

        await sawLine("sk-a...efgh");
        await sawLine("set by $GROQ_API_KEY in your environment");
        await sawLine("openrouter");
        await sawLine("not set");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("at 80 columns the env-shadow hint middle-truncates rather than reaching the border", async () => {
      const scriptPath = join(dir, "child-setup-narrow.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine, sawInFrameTimes, frameOccurrences } = await startChild(
        scriptPath,
        dir,
        { terminalSize: { cols: 80, rows: 30 } },
      );
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/setup");
        await sawLine("/setup");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("/setup — provider API keys");
        await sawInFrameTimes("environment — unset it in your shell", 1);

        expect(frameOccurrences("set by $GROQ_API_KEY in ")).toBe(1);
        expect(frameOccurrences("set by $GROQ_API_KEY in your environment")).toBe(0);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("add: a new key lands in config.json, and the raw value never appears in the pty stdout", async () => {
      const scriptPath = join(dir, "child-setup-add.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine, exited } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/setup");
        await sawLine("/setup");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("/setup — provider API keys");

        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("a");
        await wait100ms();
        await sawLine("ANTHROPIC_API_KEY for anthropic");

        const secret = "sk-ant-added-secret-key";
        child.stdin?.write(secret);
        await wait100ms();
        child.stdin?.write("\r");
        await sawLine("Saved ANTHROPIC_API_KEY.");

        const config = await waitForConfig(
          join(dir, ".seri", "config.json"),
          (c) => c.ANTHROPIC_API_KEY === secret,
        );
        expect(config.ANTHROPIC_API_KEY).toBe(secret);

        child.kill("SIGKILL");
        const { stdout } = await exited;
        expect(stdout).not.toContain(secret);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("Enter opens the enter-key step and Delete requests removal, without using the 'a'/'r' letter shortcuts", async () => {
      seedConfig(dir, { OPENROUTER_API_KEY: "sk-or-existing" });
      const scriptPath = join(dir, "child-setup-enter-delete.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine, sawLineTimes } = await startChild(scriptPath, dir);
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
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("OPENROUTER_API_KEY for openrouter");

        child.stdin?.write("\x1b");
        await new Promise((resolve) => setTimeout(resolve, 30));
        await wait100ms();
        await sawLineTimes("/setup — provider API keys", 2);

        // Raw Delete is \x1b[3~, parse-keypress.js's sequence, distinct from backspace.
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

      const { child, sawLine } = await startChild(scriptPath, dir);
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

      const { child, sawLine } = await startChild(scriptPath, dir);
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

    test("cancel: opening and closing /setup with Escape writes nothing", async () => {
      const scriptPath = join(dir, "child-setup-cancel.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/setup");
        await sawLine("/setup");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("/setup — provider API keys");

        child.stdin?.write("\x1b");
        await new Promise((resolve) => setTimeout(resolve, 30));
        await wait100ms();

        expect(existsSync(join(dir, ".seri", "config.json"))).toBe(false);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("/setup with an argument is rejected and opens no panel", async () => {
      const scriptPath = join(dir, "child-setup-bad-args.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine, rawOccurrences } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/setup now");
        await sawLine("/setup now");
        child.stdin?.write("\r");
        await sawLine("/setup: invalid arguments.");

        expect(rawOccurrences("/setup — provider API keys")).toBe(0);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("an env-shadowed row with no config entry reports the environment as the source and refuses removal", async () => {
      const scriptPath = join(dir, "child-setup-env-shadow.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir, { OPENAI_API_KEY: "sk-openai-env-value" }));

      const { child, sawLine, rawOccurrences } = await startChild(scriptPath, dir, {
        terminalSize: { cols: 100, rows: 30 },
      });
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/setup");
        await sawLine("/setup");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("/setup — provider API keys");
        await sawLine("set by $OPENAI_API_KEY in");

        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("r");
        await wait100ms();

        expect(rawOccurrences("Remove OPENAI_API_KEY")).toBe(0);
        expect(existsSync(join(dir, ".seri", "config.json"))).toBe(false);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("an env-shadowed row WITH a config entry underneath is removable", async () => {
      seedConfig(dir, { OPENAI_API_KEY: "sk-openai-config-value" });
      const scriptPath = join(dir, "child-setup-env-shadow-removable.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir, { OPENAI_API_KEY: "sk-openai-env-value" }));

      const { child, sawLine, rawOccurrences } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/setup");
        await sawLine("/setup");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("/setup — provider API keys");
        await sawLine("config entry underneath — removable");
        expect(rawOccurrences("set by $OPENAI_API_KEY in your environment")).toBe(0);

        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("r");
        await wait100ms();

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

    // A throw out of a key handler does not kill this TUI; Bun's uncaught-exception path still can.
    test("a config.json that becomes malformed while /setup is already open does not dump a stack trace", async () => {
      seedConfig(dir, { OPENROUTER_API_KEY: "sk-or-value" });
      const scriptPath = join(dir, "child-setup-malformed-config.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine, rawOccurrences } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/setup");
        await sawLine("/setup");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("/setup — provider API keys");

        const configPath = join(dir, ".seri", "config.json");
        writeFileSync(configPath, "{not valid json");

        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("r");
        await wait100ms();

        child.stdin?.write("a");
        await wait100ms();
        await sawLine("OPENROUTER_API_KEY for openrouter");

        child.stdin?.write("\x1b");
        await new Promise((resolve) => setTimeout(resolve, 30));
        await sawLine("/setup — provider API keys");

        expect(rawOccurrences("JSON Parse error")).toBe(0);
        expect(rawOccurrences("provider/keys.ts")).toBe(0);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("a logged-in /setup lists seri as a subscription and OpenRouter as a key", async () => {
      seedAuth(dir);
      const scriptPath = join(dir, "child-setup-hosted-seri.mjs");
      writeFileSync(scriptPath, childScriptLoggedInZeroKeys(dir));

      const { child, sawLine, lastFrame } = await startChild(scriptPath, dir, {
        terminalSize: { cols: 100, rows: 30 },
      });
      try {
        await sawLine("RUNLOOP_READY");
        await sawLine("done ·");

        child.stdin?.write("/setup");
        await sawLine("/setup");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("/setup — provider API keys");
        await sawLine("Subscriptions");
        await sawLine("seri");
        await sawLine("connected");
        await sawLine("openrouter");
        expect(lastFrame()).toContain("not set");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("a logged-in user can paste an OpenRouter key; it is unused while the seri plan is connected", async () => {
      seedAuth(dir);
      const scriptPath = join(dir, "child-setup-hosted-own-key.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine, lastFrame } = await startChild(scriptPath, dir, {
        terminalSize: { cols: 100, rows: 30 },
      });
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/setup");
        await sawLine("/setup");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("/setup — provider API keys");
        await sawLine("seri");

        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("OPENROUTER_API_KEY for openrouter");

        const secret = "sk-or-hosted-own-override";
        child.stdin?.write(secret);
        await wait100ms();
        child.stdin?.write("\r");
        await sawLine("Saved OPENROUTER_API_KEY.");

        const config = await waitForConfig(
          join(dir, ".seri", "config.json"),
          (c) => c.OPENROUTER_API_KEY === secret,
        );
        expect(config.OPENROUTER_API_KEY).toBe(secret);
        await sawLine("unused because a seri plan is connected");
        expect(lastFrame()).toContain("seri");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);
  });

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
    test("the sign-in banner does not appear at mount when no auth.json exists", async () => {
      const scriptPath = join(dir, "child-auth-banner.mjs");
      writeFileSync(scriptPath, childScriptAuth(dir));

      const { child, sawLine, rawOccurrences } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");
        expect(rawOccurrences("Sign in with /login, or create an account with /signup")).toBe(0);

        child.stdin?.write("still typing");
        await sawLine("still typing");
        expect(rawOccurrences("Sign in with /login, or create an account with /signup")).toBe(0);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("/login shows the device panel, then resolves: 'Logged in as …' lands in the transcript, auth.json exists, and the raw access token never reaches stdout", async () => {
      const scriptPath = join(dir, "child-auth-login.mjs");
      writeFileSync(scriptPath, childScriptAuth(dir));

      const { child, sawLine, exited } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/login");
        await sawLine("> /login");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("ABCD-1234");

        await sawLine("Logged in as fake@example.com");

        const auth = await waitForConfig(
          join(dir, ".seri", "auth.json"),
          (c) => c.email === "fake@example.com",
        );
        expect(auth.email).toBe("fake@example.com");

        child.kill("SIGKILL");
        const { stdout } = await exited;
        expect(stdout).not.toContain("fake-access-token-must-never-print");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("a failed /login shows the error, and a keypress returns to the ordinary input box", async () => {
      const scriptPath = join(dir, "child-auth-login-fails.mjs");
      writeFileSync(scriptPath, childScriptAuthLoginFails(dir));

      const { child, sawLine } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/login");
        await sawLine("> /login");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("ABCD-1234");

        await sawLine("Authorization was denied.");

        child.stdin?.write("\r");
        await wait100ms();

        child.stdin?.write("still here");
        await sawLine("still here");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("Escape abandons a stuck /login and returns to the ordinary input box", async () => {
      const scriptPath = join(dir, "child-auth-login-hangs.mjs");
      writeFileSync(scriptPath, childScriptAuthLoginHangs(dir));

      const { child, sawLine } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/login");
        await sawLine("> /login");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("ABCD-1234");

        child.stdin?.write("\x1b");
        await new Promise((resolve) => setTimeout(resolve, 30));
        await wait100ms();

        child.stdin?.write("abandoned, typing something else");
        await sawLine("abandoned, typing something else");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("Escape really cancels a stuck /login: the poll's late resolution ~1s later never writes auth.json or logs in", async () => {
      const scriptPath = join(dir, "child-auth-login-race.mjs");
      writeFileSync(scriptPath, childScriptAuthLoginRace(dir));

      const { child, sawLine, rawOccurrences } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/login");
        await sawLine("> /login");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("ABCD-1234");

        child.stdin?.write("\x1b");
        await new Promise((resolve) => setTimeout(resolve, 30));
        await wait100ms();

        child.stdin?.write("still fine");
        await sawLine("still fine");

        await new Promise((resolve) => setTimeout(resolve, 1300));

        expect(existsSync(join(dir, ".seri", "auth.json"))).toBe(false);
        expect(rawOccurrences("Logged in as fake@example.com")).toBe(0);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("/logout signs out: 'Logged out.' lands in the transcript, auth.json is cleared, and the sign-in banner does not return", async () => {
      seedAuth(dir);
      const scriptPath = join(dir, "child-auth-logout.mjs");
      writeFileSync(scriptPath, childScriptAuth(dir));

      const { child, sawLine, rawOccurrences } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/logout");
        await sawLine("/logout");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("Logged out.");

        expect(existsSync(join(dir, ".seri", "auth.json"))).toBe(false);
        expect(rawOccurrences("Sign in with /login, or create an account with /signup")).toBe(0);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("gate composition: zero keys and no auth.json show /setup without the sign-in banner; adding a key falls through to the main view still without it", async () => {
      const scriptPath = join(dir, "child-auth-gate-matrix.mjs");
      writeFileSync(scriptPath, childScriptGuidedSetup(dir));

      const pty = await startChild(scriptPath, dir);
      const { child, sawLine, rawOccurrences } = pty;
      try {
        await sawLine("/setup — provider API keys");
        expect(rawOccurrences("Sign in with /login, or create an account with /signup")).toBe(0);

        child.stdin?.write("a");
        await wait100ms();
        await sawLine("GROQ_API_KEY for groq");

        const secret = "sk-gate-matrix-secret";
        child.stdin?.write(secret);
        await wait100ms();
        child.stdin?.write("\r");
        await sawLine("Saved GROQ_API_KEY.");

        child.stdin?.write("\x1b");
        await typePickerFilter(pty, "70b-versatile");
        child.stdin?.write("\r");

        await sawLine("RUNLOOP_READY");
        expect(rawOccurrences("Sign in with /login, or create an account with /signup")).toBe(0);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);
  });

  describe("guided setup on a genuinely blank first run", () => {
    test("mounts /setup directly instead of hard-exiting, and falls through to the task once a key is added and the mandatory default model is picked", async () => {
      const scriptPath = join(dir, "child-guided-setup.mjs");
      writeFileSync(scriptPath, childScriptGuidedSetup(dir));

      const pty = await startChild(scriptPath, dir);
      const { child, sawLine } = pty;
      try {
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

        child.stdin?.write("\x1b");
        await typePickerFilter(pty, "70b-versatile");
        child.stdin?.write("\r");

        await sawLine("> do a task");
        await sawLine("RUNLOOP_READY");
        await sawLine("done ·");

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

    test("mounts /setup instantly even while the model catalog fetch is still in flight", async () => {
      const scriptPath = join(dir, "child-guided-setup-slow-fetch.mjs");
      writeFileSync(scriptPath, childScriptGuidedSetupSlowFetch(dir));

      const { child, sawLine } = await startChild(scriptPath, dir);
      try {
        const start = Date.now();
        await sawLine("/setup — provider API keys");
        expect(Date.now() - start).toBeLessThan(5000);
      } finally {
        child.kill("SIGKILL");
      }
    }, 20_000);

    test("Escape during a slow catalog fetch shows visible feedback once, not duplicated by a second press", async () => {
      const scriptPath = join(dir, "child-guided-setup-slow-fetch-escape.mjs");
      writeFileSync(scriptPath, childScriptGuidedSetupSlowFetch(dir));

      const { child, sawLine, frameOccurrences, exited } = await startChild(scriptPath, dir);
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

        child.stdin?.write("\x1b");
        await wait100ms();
        await sawLine("Loading available models…");

        child.stdin?.write("\x1b");
        await wait100ms();
        expect(frameOccurrences("Loading available models…")).toBe(1);

        child.stdin?.write("\x03");
        const { stdout } = await exited;
        expect(stdout).not.toContain("EXIT_CODE");
        expect(stdout).not.toContain("RUNLOOP_READY");
      } finally {
        child.kill("SIGKILL");
      }
    }, 20_000);

    test("adding a second key while the catalog fetch is still resolving is not discarded by the picker", async () => {
      const scriptPath = join(dir, "child-guided-setup-delayed-fetch.mjs");
      writeFileSync(scriptPath, childScriptGuidedSetupDelayedFetch(dir));

      const { child, sawLine } = await startChild(scriptPath, dir);
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

        child.stdin?.write("\x1b");
        await wait100ms();
        await sawLine("Loading available models…");

        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("a");
        await wait100ms();
        await sawLine("ANTHROPIC_API_KEY for anthropic");

        const secondSecret = "sk-guided-setup-second-key-secret";
        child.stdin?.write(secondSecret);
        await wait100ms();
        child.stdin?.write("\r");
        await sawLine("Saved ANTHROPIC_API_KEY.");

        const config = await waitForConfig(
          join(dir, ".seri", "config.json"),
          (c) => c.ANTHROPIC_API_KEY === secondSecret,
        );
        expect(config.ANTHROPIC_API_KEY).toBe(secondSecret);
        expect(config.GROQ_API_KEY).toBe(secret);

        child.stdin?.write("\x1b");
        await wait100ms();
        await sawLine("Route");
      } finally {
        child.kill("SIGKILL");
      }
    }, 20_000);

    test("removing the only key while the catalog fetch is still resolving does not open the picker for it", async () => {
      const scriptPath = join(dir, "child-guided-setup-remove-during-wait.mjs");
      writeFileSync(scriptPath, childScriptGuidedSetupDelayedFetch(dir));

      const { child, sawLine, exited } = await startChild(scriptPath, dir);
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

        child.stdin?.write("\x1b");
        await wait100ms();
        await sawLine("Loading available models…");

        child.stdin?.write("r");
        await wait100ms();
        child.stdin?.write("y");
        await sawLine("Removed GROQ_API_KEY.");

        const { stdout } = await exited;
        expect(stdout).toContain("EXIT_CODE 1");
        expect(stdout).toContain(
          "GROQ_API_KEY is not set. Set it as an environment variable and re-run.",
        );
        expect(stdout).not.toContain("Pick a default model to continue.");
      } finally {
        child.kill("SIGKILL");
      }
    }, 20_000);

    test("Ctrl-D from the enter-key step during the catalog wait gives visible feedback, not a dead key", async () => {
      const scriptPath = join(dir, "child-guided-setup-ctrld-during-wait.mjs");
      writeFileSync(scriptPath, childScriptGuidedSetupDelayedFetch(dir));

      const { child, sawLine } = await startChild(scriptPath, dir);
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

        child.stdin?.write("\x1b");
        await wait100ms();
        await sawLine("Loading available models…");

        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("a");
        await wait100ms();
        await sawLine("ANTHROPIC_API_KEY for anthropic");

        child.stdin?.write("\x04");
        await sawLine("Still loading available models");
      } finally {
        child.kill("SIGKILL");
      }
    }, 20_000);

    test("a non-groq key added during guided setup lands on the model picked there instead of a second missing-GROQ_API_KEY exit", async () => {
      const scriptPath = join(dir, "child-guided-setup-non-groq.mjs");
      writeFileSync(scriptPath, childScriptGuidedSetup(dir));

      const pty = await startChild(scriptPath, dir);
      const { child, sawLine, rawOccurrences } = pty;
      try {
        await sawLine("/setup — provider API keys");

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
        await typePickerFilter(pty, "claude-sonnet-5");
        child.stdin?.write("\r");

        await sawLine("> do a task");
        await sawLine("RUNLOOP_READY");
        await sawLine("done ·");

        const config = await waitForConfig(
          join(dir, ".seri", "config.json"),
          (c) => c.SERI_MODEL === "claude-sonnet-5",
        );
        expect(config.SERI_MODEL).toBe("claude-sonnet-5");
        expect(config.SERI_PROVIDER).toBe("anthropic");
        expect(rawOccurrences("GROQ_API_KEY is not set")).toBe(0);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("Escape at the mandatory model picker re-prompts instead of returning to a keys-but-no-model run", async () => {
      const scriptPath = join(dir, "child-guided-setup-picker-escape.mjs");
      writeFileSync(scriptPath, childScriptGuidedSetup(dir));

      const pty = await startChild(scriptPath, dir);
      const { child, sawLine } = pty;
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
        await pty.sawInFrameTimes("Type to filter", 1);

        child.stdin?.write("\x1b");
        await wait100ms();
        await sawLine("Pick a model to continue");

        await typePickerFilter(pty, "70b-versatile");
        const configDuringEscape = JSON.parse(
          readFileSync(join(dir, ".seri", "config.json"), "utf8"),
        );
        expect(configDuringEscape.SERI_MODEL).toBeUndefined();

        child.stdin?.write("\r");
        await sawLine("> do a task");
        await sawLine("RUNLOOP_READY");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("Ctrl-C at the mandatory model picker kills the run without persisting a default model", async () => {
      const scriptPath = join(dir, "child-guided-setup-picker-ctrlc.mjs");
      writeFileSync(scriptPath, childScriptGuidedSetup(dir));

      const { child, sawLine, exited } = await startChild(scriptPath, dir);
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

      const { child, sawLine, exited } = await startChild(scriptPath, dir);
      try {
        await sawLine("/setup — provider API keys");

        child.stdin?.write("\x1b");
        await new Promise((resolve) => setTimeout(resolve, 30));

        const { stdout } = await exited;
        expect(stdout).toContain("EXIT_CODE 1");
        expect(stdout).toContain(
          "GROQ_API_KEY is not set. Set it as an environment variable and re-run.",
        );
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("Esc after adding a key still opens the mandatory picker when the live catalog carries no rows for that provider", async () => {
      const scriptPath = join(dir, "child-guided-setup-catalog-missing-provider.mjs");
      writeFileSync(scriptPath, childScriptGuidedSetupCatalogMissingProvider(dir));

      const { child, sawLine } = await startChild(scriptPath, dir);
      try {
        await sawLine("/setup — provider API keys");

        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("a");
        await wait100ms();
        await sawLine("ANTHROPIC_API_KEY for anthropic");

        const secret = "sk-guided-setup-catalog-missing-provider-secret";
        child.stdin?.write(secret);
        await wait100ms();
        child.stdin?.write("\r");
        await sawLine("Saved ANTHROPIC_API_KEY.");

        child.stdin?.write("\x1b");
        await wait100ms();
        await sawLine("Route");
      } finally {
        child.kill("SIGKILL");
      }
    }, 20_000);
  });

  describe("/config", () => {
    test("add a value for a known key, then unset it — the typed value never leaks while being entered", async () => {
      const scriptPath = join(dir, "child-config.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine, rawOccurrences } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/config");
        await sawLine("/config");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("/config — settings");
        await sawLine("Automatic verification:");
        await sawLine("Verify command:");

        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("a");
        await wait100ms();
        await sawLine("Set Verify command (SERI_VERIFY_COMMAND)");

        const value = "bun run typecheck";
        child.stdin?.write(value);
        await wait100ms();
        expect(rawOccurrences(value)).toBe(0);

        child.stdin?.write("\r");
        await sawLine("Saved SERI_VERIFY_COMMAND.");

        const config = await waitForConfig(
          join(dir, ".seri", "config.json"),
          (c) => c.SERI_VERIFY_COMMAND === value,
        );
        expect(config.SERI_VERIFY_COMMAND).toBe(value);

        child.stdin?.write("r");
        await wait100ms();
        await sawLine("Unset Verify command (SERI_VERIFY_COMMAND)");

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

    test("SERI_VERIFY_ENABLED toggles on Enter without opening a text prompt", async () => {
      const scriptPath = join(dir, "child-config-toggle.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine, rawOccurrences } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/config");
        await sawLine("/config");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("/config — settings");
        await sawLine("Automatic verification: on");

        child.stdin?.write("\r");
        await sawLine("Automatic verification is now off. (takes effect on the next run)");

        const off = await waitForConfig(
          join(dir, ".seri", "config.json"),
          (c) => c.SERI_VERIFY_ENABLED === "false",
        );
        expect(off.SERI_VERIFY_ENABLED).toBe("false");
        await sawLine("Automatic verification: off");

        child.stdin?.write("\r");
        await sawLine("Automatic verification is now on. (takes effect on the next run)");

        const on = await waitForConfig(
          join(dir, ".seri", "config.json"),
          (c) => c.SERI_VERIFY_ENABLED === "true",
        );
        expect(on.SERI_VERIFY_ENABLED).toBe("true");

        expect(rawOccurrences("Set Automatic verification")).toBe(0);
        expect(rawOccurrences("value for")).toBe(0);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("toggling an env-shadowed boolean row reports the override instead of claiming the value changed", async () => {
      const scriptPath = join(dir, "child-config-toggle-env.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir, { SERI_VERIFY_ENABLED: "false" }));

      const { child, sawLine, sawLineTimes, rawOccurrences } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/config");
        await sawLine("/config");
        child.stdin?.write("\r");
        await wait100ms();
        await sawLine("/config — settings");
        await sawLine("Automatic verification: off");

        child.stdin?.write("\r");
        await sawLine("Automatic verification: off in config, SERI_VERIFY_ENABLED env still wins.");

        const config = await waitForConfig(
          join(dir, ".seri", "config.json"),
          (c) => c.SERI_VERIFY_ENABLED === "false",
        );
        expect(config.SERI_VERIFY_ENABLED).toBe("false");

        await sawLineTimes("Automatic verification: off", 2);
        expect(rawOccurrences("Automatic verification: on")).toBe(0);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);
  });

  describe("/permissions", () => {
    test("a persisted write_file grant renders, and 'r'/'y' removes it", async () => {
      const permissionsDir = join(dir, "config");
      // realpathSync: os.tmpdir() on macOS is a symlink, and the store compares resolved paths.
      const worktree = realpathSync(dir);
      const { rememberGrant, loadGrants } = await import("../../src/permissions/store");
      rememberGrant(permissionsDir, worktree, "write_file");

      const scriptPath = join(dir, "child-permissions.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine } = await startChild(scriptPath, dir);
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

    test("a global grant survives removing the same tool's project-tier entry", async () => {
      const permissionsDir = join(dir, "config");
      const worktree = realpathSync(dir);
      const { loadGrants, permissionsPath, projectKey } = await import(
        "../../src/permissions/store"
      );
      mkdirSync(permissionsDir, { recursive: true });
      writeFileSync(
        permissionsPath(permissionsDir),
        `global: [write_file]\nprojects:\n  '${projectKey(worktree)}':\n    - write_file\n`,
      );

      const scriptPath = join(dir, "child-permissions-global.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine } = await startChild(scriptPath, dir);
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

  describe("bare seri", () => {
    test("mounts idle with no auto-started turn; a typed task starts one; Ctrl-D then exits 0", async () => {
      const scriptPath = join(dir, "child-bare.mjs");
      writeFileSync(scriptPath, childScriptBare(dir));

      const { child, sawLine, exited, rawOccurrences } = await startChild(scriptPath, dir);
      try {
        await sawLine("approve-each mode on");
        await wait100ms();
        expect(rawOccurrences("RUNLOOP_READY")).toBe(0);

        child.stdin?.write("do a task");
        await sawLine("do a task");
        child.stdin?.write("\r");
        await sawLine("RUNLOOP_READY");
        await sawLine("> do a task");
        expect(rawOccurrences("RUNLOOP_READY")).toBe(1);

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

    test("ctrl+o and empty /plan share one overlay, keeping liveState in step with the indicator", async () => {
      const scriptPath = join(dir, "child-plan-toggle.mjs");
      writeFileSync(scriptPath, childScriptBare(dir));

      const { child, sawLine, lastFrame, rawOccurrences } = await startChild(scriptPath, dir, {
        terminalSize: { cols: 100, rows: 30 },
      });
      try {
        await sawLine("approve-each mode on");
        await wait100ms();
        expect(rawOccurrences("RUNLOOP_READY")).toBe(0);

        child.stdin?.write("\x0f");
        await sawLine("plan mode on");
        expect(lastFrame()).toContain("plan mode on");
        expect(lastFrame()).not.toContain("approve-each mode on");
        expect(lastFrame()).toContain("ctrl+o to leave");
        expect(lastFrame()).not.toContain("shift+tab to cycle");

        child.stdin?.write("/plan");
        await sawLine("/plan");
        child.stdin?.write("\r");

        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const frame = lastFrame();
          if (frame.includes("approve-each mode on") && !frame.includes("plan mode on")) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        expect(lastFrame()).toContain("approve-each mode on");
        expect(lastFrame()).not.toContain("plan mode on");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("SERI_REASONING_EFFORT from config.json shows the tier in the mode row before any turn runs", async () => {
      seedConfig(dir, { SERI_REASONING_EFFORT: "medium" });
      const scriptPath = join(dir, "child-effort-default-mount.mjs");
      writeFileSync(scriptPath, childScriptEffortDefaultAtMount(dir));

      const { child, sawLine, rawOccurrences } = await startChild(scriptPath, dir, {
        terminalSize: { cols: 100, rows: 30 },
      });
      try {
        await sawLine("reasoning-model · groq · medium");
        expect(rawOccurrences("RUNLOOP_READY")).toBe(0);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("quitting immediately, with nothing ever typed, persists no empty-content user message", async () => {
      const scriptPath = join(dir, "child-bare-quit.mjs");
      writeFileSync(scriptPath, childScriptBare(dir));

      const { child, sawLine, exited } = await startChild(scriptPath, dir);
      try {
        await sawLine("approve-each mode on");
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
        const ids = listSessionIds(sessionsDir);
        expect(ids).toHaveLength(1);
        const session = loadSession(ids[0]!, sessionsDir);
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

      const { child, sawLine } = await startChild(scriptPath, dir);
      try {
        await sawLine("approve-each mode on");

        child.stdin?.write("/max-turns 1");
        await sawLine("/max-turns 1");
        child.stdin?.write("\r");
        await sawLine("Max turns set to 1");

        child.stdin?.write("do a task");
        await sawLine("do a task");
        child.stdin?.write("\r");
        await sawLine("RUNLOOP_MAXITERATIONS 1");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("without a live override, the next turn's driveLoop call receives the --max-turns startup default", async () => {
      const scriptPath = join(dir, "child-max-turns-default.mjs");
      writeFileSync(scriptPath, childScriptMaxTurns(dir));

      const { child, sawLine } = await startChild(scriptPath, dir);
      try {
        await sawLine("approve-each mode on");

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

      const { child, sawLine, sawLineTimes } = await startChild(scriptPath, dir);
      try {
        await sawLine("approve-each mode on");

        child.stdin?.write("/profile new work");
        await sawLine("/profile new work");
        child.stdin?.write("\r");
        await sawLine("Profile directory");
        await sawLine("switch the running session's profile");

        const profileDir = join(dir, ".seri", "work");
        const deadline = Date.now() + 5000;
        while (!existsSync(profileDir) && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 20));
        expect(existsSync(profileDir)).toBe(true);

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

      const { child, sawLine } = await startChild(scriptPath, dir);
      try {
        await sawLine("approve-each mode on");

        child.stdin?.write("/profile new ../etc");
        await sawLine("/profile new ../etc");
        child.stdin?.write("\r");
        await sawLine("may only contain letters, numbers");

        await wait100ms();
        expect(existsSync(join(dir, "etc"))).toBe(false);
        expect(existsSync(join(dir, ".seri"))).toBe(false);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("a command-error clears once the next submission renders", async () => {
      const scriptPath = join(dir, "child-profile-new-cleared.mjs");
      writeFileSync(scriptPath, childScriptBare(dir));

      const { child, sawLine, rawOccurrences } = await startChild(scriptPath, dir);
      try {
        await sawLine("approve-each mode on");

        child.stdin?.write("/profile new");
        await sawLine("/profile new");
        child.stdin?.write("\r");
        await sawLine("Usage: /profile new <name>");

        child.stdin?.write("/mode");
        await sawLine("/mode");
        const baseline = rawOccurrences("Usage: /profile new <name>");

        child.stdin?.write("\r");
        await sawLine("permission mode is now auto");

        expect(rawOccurrences("Usage: /profile new <name>")).toBe(baseline);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);
  });

  describe("welcome splash", () => {
    test("the splash renders on a launch with an already-configured provider key, not just a first run", async () => {
      const scriptPath = join(dir, "child-splash-existing-key.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine, rawOccurrences } = await startChild(scriptPath, dir, {
        dismissSplash: false,
      });
      try {
        await sawLine(SPLASH_MARK);
        await sawLine("Continue without logging in");

        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("\r");

        await sawLine("RUNLOOP_READY");
        expect(rawOccurrences("Sign in with /login, or create an account with /signup")).toBe(0);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("an already-authenticated user sees only Continue, not Log in / Sign up", async () => {
      seedAuth(dir);
      const scriptPath = join(dir, "child-splash-authenticated.mjs");
      writeFileSync(scriptPath, childScriptSetup(dir));

      const { child, sawLine, rawOccurrences } = await startChild(scriptPath, dir, {
        dismissSplash: false,
      });
      try {
        await sawLine(SPLASH_MARK);
        await sawLine("> Continue");
        await wait100ms();

        expect(rawOccurrences("Log in")).toBe(0);
        expect(rawOccurrences("Sign up")).toBe(0);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("selecting Log in from the splash opens the same device-flow panel /login uses, and a successful login still falls through to the normal flow", async () => {
      const scriptPath = join(dir, "child-splash-login.mjs");
      writeFileSync(scriptPath, childScriptAuth(dir));

      const { child, sawLine } = await startChild(scriptPath, dir, { dismissSplash: false });
      try {
        await sawLine(SPLASH_MARK);
        await sawLine("> Log in");
        child.stdin?.write("\r");
        await sawLine("ABCD-1234");

        await sawLine("RUNLOOP_READY");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("the splash appears ahead of the mandatory /setup panel for a zero-key user, and Continue does not skip /setup", async () => {
      const scriptPath = join(dir, "child-splash-zero-key.mjs");
      writeFileSync(scriptPath, childScriptGuidedSetup(dir));

      const { child, sawLine, rawOccurrences } = await startChild(scriptPath, dir, {
        dismissSplash: false,
      });
      try {
        await sawLine(SPLASH_MARK);
        await sawLine("Continue without logging in");

        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("\x1b[B");
        await wait100ms();
        child.stdin?.write("\r");

        await sawLine("/setup — provider API keys");
        await sawLine("openrouter");
        await sawLine("not set");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("a logged-in user with zero local keys continues past splash into the main TUI, not /setup", async () => {
      seedAuth(dir);
      const scriptPath = join(dir, "child-splash-logged-in-zero-keys.mjs");
      writeFileSync(scriptPath, childScriptLoggedInZeroKeys(dir));

      const { child, sawLine, rawOccurrences, lastFrame, sawInFrameTimes } = await startChild(
        scriptPath,
        dir,
        {
          dismissSplash: false,
        },
      );
      try {
        await sawLine(SPLASH_MARK);
        await sawLine("> Continue");
        await sawLine(" · seri");
        expect(rawOccurrences("openrouter")).toBe(0);
        child.stdin?.write("\r");

        await sawLine("RUNLOOP_READY");
        expect(rawOccurrences("/setup — provider API keys")).toBe(0);
        await sawInFrameTimes("done ·", 1);
        expect(lastFrame()).toContain(" · seri");
        expect(lastFrame()).not.toContain("openrouter");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);
  });

  describe("--continue mount", () => {
    function seedSession(sessionsDir: string, messages: ModelMessage[]): void {
      saveSession(
        {
          id: "resumed",
          cwd: ".",
          systemPrompt: "",
          permissionMode: "read-only",
          messages,
        },
        sessionsDir,
      );
    }

    test("does not auto-start a turn when the resumed session's last message already has an assistant reply", async () => {
      seedSession(join(dir, "sessions"), [
        { role: "user", content: "do a task" },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ]);

      const scriptPath = join(dir, "child-continue-answered.mjs");
      writeFileSync(scriptPath, childScriptContinue(dir));

      const { child, sawLine, rawOccurrences } = await startChild(scriptPath, dir);
      try {
        await sawLine("read-only mode on");
        await wait100ms();
        expect(rawOccurrences("RUNLOOP_READY")).toBe(0);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("still auto-starts a turn when the resumed session's last message is an unanswered user message", async () => {
      seedSession(join(dir, "sessions"), [{ role: "user", content: "do a task" }]);

      const scriptPath = join(dir, "child-continue-pending.mjs");
      writeFileSync(scriptPath, childScriptContinue(dir));

      const { child, sawLine, rawOccurrences } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");
        expect(rawOccurrences("RUNLOOP_READY")).toBe(1);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);
  });

  describe("alt-screen enter/exit lifecycle", () => {
    test("/exit: enters the alt screen once and exits it once, after Ink's own teardown", async () => {
      const scriptPath = join(dir, "child-altscreen-exit.mjs");
      writeFileSync(scriptPath, childScriptQuit(dir));

      const { child, exited, sawLine, rawOccurrences } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");
        await sawLine("done ·");

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

        const { stdout } = result as Exit;
        expect(rawOccurrences("\x1b[?1049h")).toBe(1);
        expect(rawOccurrences("\x1b[?1049l")).toBe(1);
        expect(stdout.lastIndexOf("\x1b[?1049l")).toBeGreaterThan(stdout.indexOf("\x1b[?1049h"));
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("fatal Ctrl-C: exits the alt screen exactly once when the process dies by signal", async () => {
      const scriptPath = join(dir, "child-altscreen-fatal-ctrlc.mjs");
      writeFileSync(scriptPath, childScriptCancel(dir));

      const { child, exited, sawLine, rawOccurrences } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");
        child.stdin?.write("\x03");
        await sawLine("RUNLOOP_ABORTED aborted=true");
        child.stdin?.write("\x03");

        const result = await Promise.race([
          exited,
          new Promise<"the run never settled">((r) =>
            setTimeout(() => r("the run never settled"), 15_000),
          ),
        ]);
        expect(result).not.toBe("the run never settled");
        expect(rawOccurrences("\x1b[?1049l")).toBe(1);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("SIGTERM: exits the alt screen exactly once", async () => {
      const scriptPath = join(dir, "child-altscreen-sigterm.mjs");
      writeFileSync(scriptPath, childScriptSigterm(dir));

      const { child, exited, sawLine, rawOccurrences, stdoutSoFar } = await startChild(
        scriptPath,
        dir,
      );
      try {
        await sawLine("PID=");
        await sawLine("RUNLOOP_READY");
        const pidMatch = /PID=(\d+)/.exec(stdoutSoFar());
        if (pidMatch === null) throw new Error(`no PID= line in ${JSON.stringify(stdoutSoFar())}`);
        // Not child.pid: that is python3.
        process.kill(Number(pidMatch[1]), "SIGTERM");

        const result = await Promise.race([
          exited,
          new Promise<"the run never settled">((r) =>
            setTimeout(() => r("the run never settled"), 15_000),
          ),
        ]);
        expect(result).not.toBe("the run never settled");

        expect(rawOccurrences("\x1b[?1049l")).toBe(1);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("uncaught throw: exits the alt screen exactly once", async () => {
      const scriptPath = join(dir, "child-altscreen-rejects.mjs");
      writeFileSync(scriptPath, childScriptRejects(dir));

      const { exited, sawLine, rawOccurrences } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        const result = await Promise.race([
          exited,
          new Promise<"the run never settled">((r) =>
            setTimeout(() => r("the run never settled"), 15_000),
          ),
        ]);
        expect(result).not.toBe("the run never settled");

        expect(rawOccurrences("\x1b[?1049l")).toBe(1);
      } finally {
      }
    }, 60_000);
  });

  describe("transcript viewport scrolling", () => {
    test("a transcript longer than the terminal shows the newest line and hides the oldest, with the InputBox still visible", async () => {
      const scriptPath = join(dir, "child-viewport-overflow.mjs");
      writeFileSync(scriptPath, childScriptManyLines(dir));

      const { child, sawLine, lastFrame, sawInFrameTimes } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");
        await sawInFrameTimes("line-299.txt", 1);

        const frame = lastFrame();
        expect(frame).toContain("line-299.txt");
        expect(frame).not.toContain("line-0.txt");
        expect(frame).toContain("─".repeat(10));
        expect(frame).not.toContain("╭");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("PageUp shows the scrolled indicator and scrolls the newest line out of view", async () => {
      const scriptPath = join(dir, "child-viewport-pageup.mjs");
      writeFileSync(scriptPath, childScriptManyLines(dir));

      const { child, sawLine, lastFrame, sawInFrameTimes } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");
        await sawLine("line-299.txt");
        await sawLine("done ·");

        child.stdin?.write("\x1b[5~"); // Page Up
        await sawInFrameTimes("↑ scrolled — End to follow", 1);

        const frame = lastFrame();
        expect(frame).toContain("↑ scrolled — End to follow");
        expect(frame).not.toContain("line-299.txt");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("End clears the scrolled indicator and returns the newest line to view", async () => {
      const scriptPath = join(dir, "child-viewport-end.mjs");
      writeFileSync(scriptPath, childScriptManyLines(dir));

      const { child, sawLine, lastFrame } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");
        await sawLine("line-299.txt");
        await sawLine("done ·");

        child.stdin?.write("\x1b[5~"); // Page Up
        await sawLine("↑ scrolled — End to follow");

        child.stdin?.write("\x1b[F"); // End
        const deadline = Date.now() + 5_000;
        while (lastFrame().includes("↑ scrolled") && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 20));
        }

        const frame = lastFrame();
        expect(frame).not.toContain("↑ scrolled");
        expect(frame).toContain("line-299.txt");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);
  });

  function listSessionRefs(gitDir: string): string[] {
    const result = spawnSync(
      "git",
      ["--git-dir", gitDir, "for-each-ref", "--format=%(refname)", "refs/seri/sessions/"],
      { encoding: "utf8" },
    );
    return result.stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
  }

  describe.skipIf(!isGitAvailable())("/clear rebinds checkpointing", () => {
    test("a tool call after /clear checkpoints under the new session; the old session's file and ref are untouched", async () => {
      const scriptPath = join(dir, "child-clear.mjs");
      writeFileSync(scriptPath, childScriptClear(dir));

      const sessionsDir = join(dir, "sessions");
      const storeDir = checkpointStoreDir(join(dir, "checkpoints"), realpathSync(dir));
      const gitDir = join(storeDir, "git");

      const { child, sawLine } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY 1");
        await sawLine("WROTE 1");
        await sawLine("done ·");

        const ids1 = listSessionIds(sessionsDir);
        expect(ids1).toHaveLength(1);
        const oldId = ids1[0]!;
        const oldSnapshot = loadSession(oldId, sessionsDir);
        const oldRef = `refs/seri/sessions/${oldId}`;
        const oldCommitBeforeClear = resolveRef(gitDir, oldRef);
        expect(oldCommitBeforeClear).toBeDefined();

        child.stdin?.write("/clear");
        await sawLine("/clear");
        child.stdin?.write("\r");
        await sawLine("Started a new session");

        const ids2 = listSessionIds(sessionsDir).filter((id) => id !== oldId);
        expect(ids2).toHaveLength(1);
        const newId = ids2[0]!;

        child.stdin?.write("do another task");
        await sawLine("do another task");
        child.stdin?.write("\r");

        await sawLine("RUNLOOP_READY 2");
        await sawLine("WROTE 2");
        await sawLine("done ·");

        const newRef = `refs/seri/sessions/${newId}`;
        expect(resolveRef(gitDir, newRef)).toBeDefined();

        expect(loadSession(oldId, sessionsDir)).toEqual(oldSnapshot);
        expect(resolveRef(gitDir, oldRef)).toBe(oldCommitBeforeClear);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("checkpointing still rebinds off the old session even when /clear's own persist fails", async () => {
      const scriptPath = join(dir, "child-clear-persist-failure.mjs");
      writeFileSync(scriptPath, childScriptClear(dir));

      const sessionsDir = join(dir, "sessions");
      const storeDir = checkpointStoreDir(join(dir, "checkpoints"), realpathSync(dir));
      const gitDir = join(storeDir, "git");

      const { child, sawLine } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY 1");
        await sawLine("WROTE 1");
        await sawLine("done ·");

        const ids1 = listSessionIds(sessionsDir);
        expect(ids1).toHaveLength(1);
        const oldId = ids1[0]!;
        const oldRef = `refs/seri/sessions/${oldId}`;
        const oldCommitBeforeClear = resolveRef(gitDir, oldRef);
        expect(oldCommitBeforeClear).toBeDefined();
        const refsBeforeClear = listSessionRefs(gitDir);

        lockSessionStore(sessionsDir);

        child.stdin?.write("/clear");
        await sawLine("/clear");
        child.stdin?.write("\r");
        await sawLine("could not save the session");

        restoreSessionStore(sessionsDir);

        child.stdin?.write("do another task");
        await sawLine("do another task");
        child.stdin?.write("\r");

        await sawLine("RUNLOOP_READY 2");
        await sawLine("WROTE 2");
        await sawLine("done ·");

        expect(resolveRef(gitDir, oldRef)).toBe(oldCommitBeforeClear);

        const newRefs = listSessionRefs(gitDir).filter((ref) => !refsBeforeClear.includes(ref));
        expect(newRefs).toHaveLength(1);
        expect(resolveRef(gitDir, newRefs[0] ?? "")).toBeDefined();
      } finally {
        restoreSessionStore(sessionsDir);
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("/clear rebuilds archivist state — a stale tool-call count does not survive it", async () => {
      const scriptPath = join(dir, "child-clear-archivist.mjs");
      writeFileSync(scriptPath, childScriptClearArchivist(dir));

      const { child, sawLine, sawLineTimes, rawOccurrences } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY 1");
        await sawLine("EMITTED 1 9");
        await sawLine("done ·");

        child.stdin?.write("/clear");
        await sawLine("/clear");
        child.stdin?.write("\r");
        await sawLine("Started a new session");

        child.stdin?.write("do another task");
        await sawLine("do another task");
        child.stdin?.write("\r");

        await sawLine("RUNLOOP_READY 2");
        await sawLine("EMITTED 2 1");
        await sawLineTimes("done ·", 2);
        await new Promise((r) => setTimeout(r, 2_000));

        // 9 pre-clear + 1 post-clear would cross ARCHIVIST_TOOL_CALL_INTERVAL (10) if the counter survived.
        expect(rawOccurrences("(archivist:")).toBe(0);

        child.stdin?.write("do a third task");
        await sawLine("do a third task");
        child.stdin?.write("\r");

        await sawLine("RUNLOOP_READY 3");
        await sawLine("EMITTED 3 9");
        await sawLine("(archivist:");

        expect(rawOccurrences("(archivist:")).toBe(1);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);
  });

  describe("/clear end-to-end", () => {
    test("/clear during an in-flight turn is refused; session and messages are untouched", async () => {
      const scriptPath = join(dir, "child-clear-midturn.mjs");
      writeFileSync(scriptPath, childScriptInput(dir));

      const sessionsDir = join(dir, "sessions");
      const { child, sawLine } = await startChild(scriptPath, dir);
      try {
        await sawLine("RUNLOOP_READY");

        child.stdin?.write("/clear");
        await sawLine("/clear");
        child.stdin?.write("\r");

        await sawLine("/clear: can't run while a turn is in flight.");

        const ids = listSessionIds(sessionsDir);
        expect(ids).toHaveLength(1);
        const loaded = loadSession<ModelMessage>(ids[0]!, sessionsDir);
        expect(loaded.messages).toEqual([{ role: "user", content: "do a task" }]);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    describe.skipIf(!isGitAvailable())("after a real /clear", () => {
      test("the transcript shows the confirmation, not the echoed `> /clear`", async () => {
        const scriptPath = join(dir, "child-clear-visible.mjs");
        writeFileSync(scriptPath, childScriptClear(dir));

        const { child, sawLine, lastFrame } = await startChild(scriptPath, dir);
        try {
          await sawLine("RUNLOOP_READY 1");
          await sawLine("WROTE 1");
          await sawLine("done ·");

          child.stdin?.write("/clear");
          await sawLine("/clear");
          child.stdin?.write("\r");
          await sawLine("Started a new session");

          const frame = lastFrame();
          expect(frame).toContain("Started a new session");
          expect(frame).not.toContain("> /clear");
        } finally {
          child.kill("SIGKILL");
        }
      }, 60_000);

      test("the old session's messages are exactly its pre-/clear messages, none of the post-/clear turn", async () => {
        const scriptPath = join(dir, "child-clear-persist.mjs");
        writeFileSync(scriptPath, childScriptClear(dir));

        const sessionsDir = join(dir, "sessions");
        const { child, sawLine } = await startChild(scriptPath, dir);
        try {
          await sawLine("RUNLOOP_READY 1");
          await sawLine("WROTE 1");
          await sawLine("done ·");

          const ids1 = listSessionIds(sessionsDir);
          expect(ids1).toHaveLength(1);
          const oldId = ids1[0]!;
          const preClearMessages = loadSession<ModelMessage>(oldId, sessionsDir).messages;

          child.stdin?.write("/clear");
          await sawLine("/clear");
          child.stdin?.write("\r");
          await sawLine("Started a new session");

          child.stdin?.write("do another task");
          await sawLine("do another task");
          child.stdin?.write("\r");
          await sawLine("RUNLOOP_READY 2");
          await sawLine("WROTE 2");
          await sawLine("done ·");

          expect(loadSession<ModelMessage>(oldId, sessionsDir).messages).toEqual(preClearMessages);
        } finally {
          child.kill("SIGKILL");
        }
      }, 60_000);
    });
  });
  describe("message queue", () => {
    async function queueOneBehindTurn() {
      const scriptPath = join(dir, "queue.mjs");
      writeFileSync(scriptPath, childScriptQueue(dir));
      const started = await startChild(scriptPath, dir);
      await started.sawLine("RUNLOOP_CALL 1");
      started.child.stdin?.write("second message");
      await started.sawInFrameTimes("second message", 1);
      started.child.stdin?.write("\r");
      await started.sawInFrameTimes("1 queued", 1);
      return { ...started, scriptPath };
    }

    async function queueTwoBehindTurn() {
      const started = await queueOneBehindTurn();
      started.child.stdin?.write("third message");
      await started.sawInFrameTimes("third message", 1);
      started.child.stdin?.write("\r");
      await started.sawInFrameTimes("2 queued", 1);
      return started;
    }

    test("Enter during a turn queues the message instead of echoing and dropping it", async () => {
      const { child, lastFrame, frameOccurrences } = await queueOneBehindTurn();
      try {
        const frame = lastFrame();
        expect(frame).toContain("1 queued");
        expect(frame).toContain("second message");
        expect(frameOccurrences("> second message")).toBe(0);
        expect(frame).not.toContain("A turn is already running");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("Escape cancels the turn and the queue head starts on its own", async () => {
      const { child, sawLine } = await queueOneBehindTurn();
      try {
        child.stdin?.write("\x1b");
        await sawLine("RUNLOOP_ABORTED 1");
        await sawLine("RUNLOOP_CALL 2");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("a two-row queue advances one row per cancel instead of rotating", async () => {
      const { child, sawLine, sawInFrameTimes } = await queueTwoBehindTurn();
      try {
        child.stdin?.write("\x1b");
        await sawLine("RUNLOOP_CALL 2");
        await sawInFrameTimes("1 queued", 1);
        child.stdin?.write("\x1b");
        await sawLine("RUNLOOP_CALL 3");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("promoting the queue head never leaves two adjacent user messages", async () => {
      const { child, sawLine } = await queueOneBehindTurn();
      try {
        child.stdin?.write("\x1b");
        await sawLine("RUNLOOP_CALL 2");

        const sessionsDir = join(dir, "sessions");
        const sessionId = requireSessionId(sessionsDir);
        const deadline = Date.now() + 5_000;
        let messages: { role: string }[] = [];
        do {
          messages = loadSession(sessionId, sessionsDir).messages as { role: string }[];
        } while (messages.length < 5 && Date.now() < deadline);

        const adjacent = messages.filter(
          (message, index) =>
            index > 0 && message.role === "user" && messages[index - 1].role === "user",
        );
        expect(adjacent).toEqual([]);
        // 5 rather than 3 is what keeps this from a vacuous pass.
        expect(messages.length).toBeGreaterThanOrEqual(5);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("Ctrl-C cancels and the queue head starts, the same as Escape", async () => {
      const { child, sawLine, lastFrame } = await queueOneBehindTurn();
      try {
        child.stdin?.write("\x03");
        await sawLine("RUNLOOP_ABORTED 1");
        await sawLine("RUNLOOP_CALL 2");
        expect(lastFrame()).not.toContain("discarded");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("quitting with something queued says so and does not start it", async () => {
      const { child, exited, sawLine, rawOccurrences } = await queueOneBehindTurn();
      try {
        child.stdin?.write("/exit\r");
        await sawLine("1 queued message discarded");
        await sawLine("RUNLOOP_ABORTED 1");
        await exited;
        expect(rawOccurrences("RUNLOOP_CALL 2")).toBe(0);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

    test("a second Escape during the unwind is inert, not fatal", async () => {
      const { child, sawLine } = await queueOneBehindTurn();
      try {
        // One Escape per tick: three ESC bytes in one read become a CSI.
        child.stdin?.write("\x1b");
        await sawLine("RUNLOOP_ABORTED 1");
        child.stdin?.write("\x1b");
        child.stdin?.write("\x1b");
        await sawLine("RUNLOOP_CALL 2");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);
  });
});
