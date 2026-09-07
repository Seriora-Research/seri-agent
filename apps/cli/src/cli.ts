import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { parseArgs } from "node:util";
import { flushSync } from "@opentui/react";
import { DaemonClient, isLoopDaemonEvent } from "@seri/daemon-client";
import {
  findCatalogEntry,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelProvider,
} from "@seri/model-catalog";
import type { Plan } from "@seri/plans";
import type { LanguageModel, LanguageModelUsage, ModelMessage, ToolSet } from "ai";
import { createElement } from "react";
import pkg from "../package.json";
import { onAbort } from "./abort";
import type { loadAgentsFile as loadAgentsFileReal } from "./agents/loadAgentsFile";
import { buildSystemPrompt, buildVolatileTier, joinTiers } from "./agents/systemPrompt";
import { createAskUserPark } from "./ask-user/park";
import type { HumanReply } from "./ask-user/types";
import { ensureOwnerOnlyDir } from "./atomicWriteFile";
import type { connectCodex as connectCodexReal } from "./auth/codexConnect";
import type { login as loginReal, logout as logoutReal } from "./auth/commands";
import { effectiveHostedPlan, hostedPlanUsable } from "./auth/seriIgnore";
import type { connectGrok as connectGrokReal } from "./auth/xaiConnect";
import {
  appendBarrier,
  type Checkpointer,
  createCheckpointer,
  type RestorePlan,
  type RestoreResult,
} from "./checkpoint/checkpoint";
import { withCheckpoints } from "./checkpoint/wrapTools";
import {
  assertTuiHandlers,
  COMMAND_META,
  type CommandMeta,
  commandByName,
  isTuiClaimed,
  sessionMeta,
  startsATurn,
} from "./cli/commandCatalog";
import {
  approvalPromptText,
  archivistLine,
  archivistStagedLines,
  archivistStatsLine,
  printCost,
  printEvent,
  printGrantPersisted,
  printPreApproved,
  printUsage,
  printWarning,
  type RunUsage,
  recoveryLines,
  USAGE,
  undoPlanLines,
  usageError,
} from "./cli/output";
import {
  loadConfig,
  loadReasoningEffortConfig,
  loadSandboxConfig,
  loadTrajectoryConfig,
  loadVerifyConfig,
  persistDefaultReasoningEffort,
  setConfigValue,
  type VerifyConfig,
} from "./config/config";
import {
  getConfigDir,
  getTrajectoriesDir,
  profileNameError,
  resolveProfile,
  resolveUserHome,
  setProfileOverride,
} from "./config/paths";
import { readDaemonDescriptorFile } from "./daemon/descriptor";
import type { RunScheduled } from "./daemon/scheduler";
import {
  type ExecuteTurn,
  type StartedDaemon,
  startDaemon as startDaemonReal,
} from "./daemon/server";
import { runDoctorChecks } from "./doctor/checks";
import { doctorExitCode, printDoctorReport } from "./doctor/report";
import { messageOf } from "./errors";
import type { PermissionMode } from "./gate/gate";
import { locationForCall } from "./gate/workingDir";
import { decideHooksCommand } from "./hooks/commands";
import type { HooksLoad } from "./hooks/registry";
import { compactMessages, findSafeEvictionBoundary } from "./loop/compaction";
import {
  type ApprovalAnswer,
  type ApprovalDetail,
  type ApprovalPrompt,
  DEFAULT_PRESERVE_RECENT_TOKENS,
  type LoopEvent,
  type runLoop as runLoopReal,
} from "./loop/loop";
import { createSessionDial, fetchCatalog, isAuthRequired } from "./mcp/client";
import {
  decideMcpCommand,
  type McpRegistryChange,
  mcpLoginLine,
  mcpPanelRows,
} from "./mcp/commands";
import { loginMcpServer, type McpLoginResult } from "./mcp/login";
import { writeCatalogCache } from "./mcp/registry";
import type { McpCatalog } from "./mcp/types";
import {
  type ArchivistReport,
  type ArchivistState,
  createArchivistState,
  resetArchivistForRewind,
} from "./memory/archivist";
import { decideMemoryCommand, memoryDiffLines, memoryPanelRows } from "./memory/commands";
import { type LoadedMemory, loadMemory } from "./memory/store";
import { type PromptChannel, parsePromptChannel } from "./permissions/promptChannel";
import { effectiveTools, isPersistableTool, loadGrants, rememberGrant } from "./permissions/store";
import { unlinkPlanFile } from "./plan/files";
import {
  isPlanOverlayOn,
  type PlanAnswers,
  type PlanQuestion,
  type PlanReviewDecision,
} from "./plan/mode";
import { fetchAccountPlan } from "./provider/accountStatus";
import type { getAnthropicModel as getAnthropicModelReal } from "./provider/anthropic";
import {
  catalogForModelPicker,
  getModelCatalog,
  isCodexPlanCatalogApplied,
  prewarmModelCatalog,
} from "./provider/catalog";
import type { CostReport } from "./provider/cost";
import { DEFAULT_PROVIDER, persistDefaultModel, resolveDefaultModel } from "./provider/defaults";
import type { getGatewayModel as getGatewayModelReal } from "./provider/gateway";
import type { getGoogleModel as getGoogleModelReal } from "./provider/google";
import type { getGroqModel as getGroqModelReal } from "./provider/groq";
import { configuredProviders, PROVIDER_DISPLAY_NAMES, tuiMissingKeyMessage } from "./provider/keys";
import { dispatchModel } from "./provider/model";
import type { getOpenAIModel as getOpenAIModelReal } from "./provider/openai";
import type { getOpenRouterModel as getOpenRouterModelReal } from "./provider/openrouter";
import {
  appliedReasoningEffort,
  type EffortCommandResult,
  resolveEffortCommand,
  resolveReasoningEffort,
} from "./provider/reasoning";
import {
  gatewayCoverageInGroup,
  NATIVE_PROVIDERS,
  type ResolvedRoute,
  resolveLegalReasoningTiers,
  resolveRoute,
  resolveSessionRoute,
} from "./provider/routing";
import { modelPickerSubscribedProviders, subscribedProviders } from "./provider/subscriptions";
import { toolDefinitions } from "./provider/tools";
import type { RuleRegistry } from "./rules/registry";
import {
  addCost,
  addTokens,
  type DriveLoopResult,
  driveLoop,
  exitCodeFromDriveResult,
} from "./runtime/drive";
import { defaultBangRunners, submitBang } from "./sandbox/bang";
import { probeConfinement } from "./sandbox/confine";
import { parseBangLine, resolveShellLaunch } from "./sandbox/policy";
import { awaitsReply } from "./session/awaitsReply";
import { configDirForStore, SessionDatabase } from "./session/database";
import { type SessionState, saveSession } from "./session/session";
import { deliverSignal, onSignalCancel, raiseSignal } from "./signals";
import { decideSkillsCommand, skillsPanelRows } from "./skills/commands";
import { readSkillBody, type SkillRegistry, substituteSkillArgs } from "./skills/registry";
import type { AgentRegistry, AgentSpec } from "./subagents/registry";
import { grep as grepReal } from "./tools/grep";
import { probeRipgrep } from "./tools/selftest";
import { createTrajectoryWriter, type TrajectoryWriter } from "./trajectory/writer";
import { App } from "./tui/app";
import { chromeLoadFromFetch } from "./tui/routes/chrome/ChromePanel";
import { runGuidedSetup } from "./tui/routes/setup/guidedSetup";
import { runWelcomeSplash } from "./tui/routes/setup/welcomeSplash";
import { destroyTuiRenderer, getTuiRenderer } from "./tui/runtime/renderer";
import type { CompletionSource } from "./tui/util/completion";
import { runUpdate } from "./update/run";
import { runUsageCommand as runUsageCommandReal } from "./usage/command";
import { fetchUsageReport } from "./usage/fetch";

export { addCost, addTokens };

import {
  bindSession,
  dirs,
  fatalDuringTui,
  gatewayNotice,
  type PreMountMessage,
  type PreparedRun,
  prepareSession,
  type RunSession,
  rerouteNotice,
  resolveModelRoute,
  runStart,
} from "./runtime/prepare";

export type { PreMountMessage, PreparedRun, RunSession };

import {
  type CommandDirs,
  checkpointTarget,
  decideClear,
  decideConfigOpen,
  decideEffortOpen,
  decideMaxTurns,
  decideModeCycle,
  decideModelPickerOpen,
  decidePermissionsOpen,
  decideProfileCreate,
  decideRestore,
  decideRewind,
  decideSetupOpen,
  decideTrajectoryCommand,
  decideUndo,
} from "./tui/state/commands";
import {
  createAuthHandlers,
  createConfigHandlers,
  createEffortHandlers,
  createPermissionsHandlers,
  createSetupHandlers,
} from "./tui/state/handlers";
import { type Dispatch, initialTuiState, type TuiState, tuiReducer } from "./tui/state/reducer";
import { estimateTokens, formatRouteLabelFromResolved } from "./tui/util/format";
import { withVerification } from "./verify/wrapTools";

export type CliDeps = {
  runLoop?: typeof runLoopReal;
  getGroqModel?: typeof getGroqModelReal;
  getOpenRouterModel?: typeof getOpenRouterModelReal;
  getAnthropicModel?: typeof getAnthropicModelReal;
  getOpenAIModel?: typeof getOpenAIModelReal;
  getGoogleModel?: typeof getGoogleModelReal;
  getGatewayModel?: typeof getGatewayModelReal;
  loadAgentsFile?: typeof loadAgentsFileReal;
  loadExtensions?: (
    cwd: string,
    configDir: string,
  ) => { skills: SkillRegistry; rules: RuleRegistry; hooks: HooksLoad };
  sessionsDir?: string;
  checkpointsDir?: string;
  authConfigDir?: string;
  login?: typeof loginReal;
  logout?: typeof logoutReal;
  connectGrok?: typeof connectGrokReal;
  connectCodex?: typeof connectCodexReal;
  usageCommand?: typeof runUsageCommandReal;
  startDaemon?: typeof startDaemonReal;
  executeTurn?: ExecuteTurn;
  runScheduled?: RunScheduled;
  onIdleFlush?: (sessionId: string, signal: AbortSignal) => Promise<void>;
  waitForServe?: () => Promise<void>;
  fetch?: typeof fetch;
  permissionsDir?: string;
  grep?: typeof grepReal;
  execPath?: string;
  smokeUpdate?: (binaryPath: string) => Promise<void>;
  createInterface?: () => Interface;
  isTTY?: boolean;
};

type CommandPresenter = {
  message: (text: string) => void;
  onPlan: (plan: RestorePlan) => void;
  restore: (result: { plan: RestoreResult; message: string }) => void;
  sessionUpdated: (next: SessionState<ModelMessage>) => Promise<void>;
  transcriptCleared: () => void;
  usageAccrued: (usage: LanguageModelUsage) => void;
  cancelled: (signal: NodeJS.Signals) => void;
  currentSession: () => SessionState<ModelMessage>;
};

type SlashCommand = {
  accepts: (args: string[]) => boolean;
  mutatesRunState?: true;
  scopeTargetToCwd?: true;
} & (
  | {
      needsSession?: true;
      run: (
        session: SessionState<ModelMessage>,
        args: string[],
        dirs: CommandDirs,
        presenter: CommandPresenter,
        deps?: CliDeps,
      ) => void | Promise<void>;
    }
  | {
      needsSession: false;
      run: (
        args: string[],
        dirs: CommandDirs,
        presenter: CommandPresenter,
        deps?: CliDeps,
      ) => void | Promise<void>;
    }
);

function requireSessionMeta(name: string): Extract<CommandMeta, { surface: "session" }> {
  const meta = commandByName(name);
  if (meta === undefined || meta.surface !== "session") {
    throw new Error(`${name} is not a session command`);
  }
  return meta;
}

function sessionSlash(
  name: string,
  run: Extract<SlashCommand, { needsSession?: true }>["run"],
): [string, SlashCommand] {
  const meta = requireSessionMeta(name);
  if (meta.needsSession === false) {
    throw new Error(`${name} is session-less; use sessionSlashNoSession`);
  }
  return [
    name,
    {
      accepts: meta.accepts,
      run,
      ...(meta.mutatesRunState === true ? { mutatesRunState: true as const } : {}),
      ...(meta.scopeTargetToCwd === true ? { scopeTargetToCwd: true as const } : {}),
    },
  ];
}

function sessionSlashNoSession(
  name: string,
  run: Extract<SlashCommand, { needsSession: false }>["run"],
): [string, SlashCommand] {
  const meta = requireSessionMeta(name);
  if (meta.needsSession !== false) {
    throw new Error(`${name} requires a session`);
  }
  return [
    name,
    {
      accepts: meta.accepts,
      needsSession: false,
      run,
      ...(meta.mutatesRunState === true ? { mutatesRunState: true as const } : {}),
    },
  ];
}

// A Map, because an object lookup keyed on user input walks Object.prototype (`toString`, `constructor`, `__proto__`).
export const SLASH_COMMANDS = new Map<string, SlashCommand>([
  sessionSlash("/mode", cycleModeCommand),
  sessionSlash("/effort", effortCommand),
  sessionSlash("/undo", undoCommand),
  sessionSlash("/restore", restoreCommand),
  sessionSlash("/rewind", rewindCommand),
  sessionSlash("/clear", clearCommand),
  sessionSlash("/compact", compactCommand),
  sessionSlashNoSession("/memory", memoryCommand),
  sessionSlashNoSession("/trajectory", trajectoryCommand),
  sessionSlashNoSession("/usage", usageCommand),
]);

for (const meta of sessionMeta()) {
  if (!SLASH_COMMANDS.has(meta.name)) {
    throw new Error(`SLASH_COMMANDS missing ${meta.name}`);
  }
}

async function cycleModeCommand(
  session: SessionState<ModelMessage>,
  _args: string[],
  dirs: CommandDirs,
  presenter: CommandPresenter,
): Promise<void> {
  const { next, message } = decideModeCycle(session);
  await presenter.sessionUpdated(next);
  presenter.message(message);
}

async function applyEffortResult(
  session: SessionState<ModelMessage>,
  result: EffortCommandResult,
  presenter: CommandPresenter,
): Promise<void> {
  if (result.changed) {
    await presenter.sessionUpdated({ ...session, reasoningEffort: result.reasoningEffort });
  }
  presenter.message(result.message);
}

async function applyEffortCommand(
  session: SessionState<ModelMessage>,
  args: string[],
  catalog: ModelCatalog,
  plan: Plan | null,
  configDir: string,
  presenter: CommandPresenter,
): Promise<void> {
  const configured = configuredProviders(configDir);
  const route = resolveSessionRoute(session, catalog, configured, plan, configDir);
  const legalTiers = resolveLegalReasoningTiers(route, catalog);
  const current = resolveReasoningEffort(session, loadConfig(configDir));

  const result = resolveEffortCommand(args, legalTiers, current);
  await applyEffortResult(session, result, presenter);
}

async function effortCommand(
  session: SessionState<ModelMessage>,
  args: string[],
  dirs: CommandDirs,
  presenter: CommandPresenter,
): Promise<void> {
  if (args[0] === "auto") {
    await applyEffortResult(session, resolveEffortCommand(args, [], undefined), presenter);
    return;
  }
  const [catalog, plan] = await Promise.all([
    getModelCatalog(undefined, undefined, dirs.configDir),
    fetchAccountPlan(dirs.configDir),
  ]);
  await applyEffortCommand(session, args, catalog, plan, dirs.configDir, presenter);
}

function undoCommand(
  session: SessionState<ModelMessage>,
  args: string[],
  dirs: CommandDirs,
  presenter: CommandPresenter,
): void {
  presenter.restore(decideUndo(session, args, dirs, presenter.onPlan));
  dirs.trajectory?.recordCheckpoint({ op: "pre-undo" });
}

function restoreCommand(
  session: SessionState<ModelMessage>,
  args: string[],
  dirs: CommandDirs,
  presenter: CommandPresenter,
): void {
  presenter.restore(decideRestore(session, args, dirs, presenter.onPlan));
  dirs.trajectory?.recordCheckpoint({ op: "pre-undo" });
}

async function rewindCommand(
  session: SessionState<ModelMessage>,
  args: string[],
  dirs: CommandDirs,
  presenter: CommandPresenter,
): Promise<void> {
  const { next, message, recordBarrier } = decideRewind(session, args, dirs);
  await presenter.sessionUpdated(next);
  if (recordBarrier()) dirs.trajectory?.recordCheckpoint({ op: "rewind-barrier" });
  presenter.message(message);
}

async function compactCommand(
  session: SessionState<ModelMessage>,
  args: string[],
  dirs: CommandDirs,
  presenter: CommandPresenter,
  deps: CliDeps = {},
): Promise<void> {
  const evictBoundary = findSafeEvictionBoundary(session.messages, DEFAULT_PRESERVE_RECENT_TOKENS);
  if (evictBoundary === null) {
    presenter.message("Not enough history to compact.");
    return;
  }
  presenter.message("⚙ compacting…");

  const configDir = deps.authConfigDir ?? getConfigDir();
  const requested =
    session.model === undefined
      ? resolveDefaultModel(configDir)
      : { model: session.model, provider: session.provider };
  const { model, route } = await resolveModelRoute(
    requested,
    configDir,
    session.id,
    deps,
    printWarning,
  );

  const controller = new AbortController();
  let cancelledSignal: NodeJS.Signals | undefined;
  const unregisterCancel = onSignalCancel((signal) => {
    cancelledSignal = signal;
    controller.abort();
  });
  let compacted: Awaited<ReturnType<typeof compactMessages>>;
  try {
    const customInstructions = args.join(" ").trim();
    compacted = await compactMessages(session.messages, model, evictBoundary, controller.signal, {
      stream: route.credential === "subscription" && route.provider === "openai",
      customInstructions: customInstructions.length > 0 ? customInstructions : undefined,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      presenter.cancelled(cancelledSignal as NodeJS.Signals);
      return;
    }
    throw err;
  } finally {
    unregisterCancel();
  }

  await presenter.sessionUpdated({ ...presenter.currentSession(), messages: compacted.messages });
  const { storeDir } = checkpointTarget(session, dirs);
  try {
    appendBarrier(storeDir, session.id, "compaction");
    dirs.trajectory?.recordCheckpoint({ op: "compaction-barrier" });
  } catch (err) {
    printWarning(
      `could not record the compaction barrier, so /rewind may not be able to cross this point: ${messageOf(err)}`,
    );
  }
  presenter.usageAccrued(compacted.usage);
  presenter.message(`⚙ compacted ${compacted.evictedCount} messages`);
}

async function clearCommand(
  session: SessionState<ModelMessage>,
  _args: string[],
  dirs: CommandDirs,
  presenter: CommandPresenter,
): Promise<void> {
  const { next, message } = decideClear(session, dirs.configDir);
  await presenter.sessionUpdated(next);
  presenter.transcriptCleared();
  presenter.message(message);
}

async function memoryCommand(
  args: string[],
  dirs: CommandDirs,
  presenter: CommandPresenter,
): Promise<void> {
  const { lines } = decideMemoryCommand(args, { configDir: dirs.configDir });
  for (const line of lines) presenter.message(line.text);
}

function trajectoryCommand(args: string[], dirs: CommandDirs, presenter: CommandPresenter): void {
  const currentlyEnabled =
    dirs.trajectory?.isEnabled() ?? loadTrajectoryConfig(dirs.configDir).enabled;
  const decided = decideTrajectoryCommand(args, currentlyEnabled);
  if (decided.enabled !== undefined) {
    setConfigValue("SERI_TRAJECTORY_ENABLED", decided.enabled ? "true" : "false", dirs.configDir);
    dirs.trajectory?.setEnabled(decided.enabled);
  }
  let message = decided.message;
  if (decided.enabled !== undefined && process.env.SERI_TRAJECTORY_ENABLED !== undefined) {
    message +=
      " SERI_TRAJECTORY_ENABLED in the environment will still win the next time you start seri.";
  }
  presenter.message(message);
}

async function usageCommand(
  args: string[],
  dirs: CommandDirs,
  presenter: CommandPresenter,
  deps?: CliDeps,
): Promise<void> {
  const fn = deps?.usageCommand ?? runUsageCommandReal;
  await fn(dirs.configDir, {
    detail: args[0] === "--detail",
    presenter,
  });
}

export function chooseInterfaceOutput(): NodeJS.WritableStream {
  return process.stderr.isTTY
    ? process.stderr
    : process.stdout.isTTY
      ? process.stdout
      : process.stderr;
}

// Node readline in terminal mode puts stdin in raw mode, so 0x03 fires `rl` SIGINT and never `process` SIGINT.
function makeApprovalPrompt(
  openInterface: () => Interface = () =>
    createInterface({ input: process.stdin, output: chooseInterfaceOutput() }),
  cwd: () => string = () => process.cwd(),
): ApprovalPrompt {
  // Node EventEmitters do not replay `end` to a late listener, so a second readline.Interface on an already-ended stdin hangs forever.
  let ended = false;

  return (toolName, args, signal, detail) =>
    new Promise<ApprovalAnswer>((resolve) => {
      if (signal?.aborted === true || ended) {
        resolve("no");
        return;
      }
      const offersAlways =
        isPersistableTool(toolName) && locationForCall(cwd(), toolName, args) !== "outside";
      let answered = false;
      const rl = openInterface();
      const abort = onAbort(signal, () => {
        answered = true;
        rl.close();
        resolve("no");
      });
      rl.on("close", () => {
        if (!answered) {
          answered = true;
          // Node readline fires `close` on Ctrl-D at an empty line without ending the stream (`input.readableEnded` stays false).
          if (inputHasEnded(rl)) ended = true;
          abort.dispose();
          resolve("no");
        }
      });
      rl.on("SIGINT", () => deliverSignal("SIGINT"));
      rl.question(
        approvalPromptText(toolName, args, offersAlways, detail?.classifierReason),
        (answer) => {
          answered = true;
          abort.dispose();
          rl.close();
          const typed = answer.trim().toLowerCase();
          const wantsAlways = offersAlways && (typed === "a" || typed === "always");
          resolve(typed === "y" || typed === "yes" ? "once" : wantsAlways ? "always" : "no");
        },
      );
    });
}

// readline.Interface.input is stable at runtime but missing from `@types/node`.
function inputHasEnded(rl: Interface): boolean {
  return (
    (rl as unknown as { input: NodeJS.ReadableStream & { readableEnded?: boolean } }).input
      .readableEnded === true
  );
}

const PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  selftest: { type: "boolean" },
  resume: { type: "string" },
  continue: { type: "boolean" },
  "max-turns": { type: "string" },
  "dangerously-skip-permissions": { type: "boolean" },
  "permission-prompts": { type: "string" },
  profile: { type: "string" },
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
    "permission-prompts"?: string;
    profile?: string;
  };
  positionals: string[];
  maxTurns: number | undefined;
  skipPermissions: boolean;
  promptChannel: PromptChannel;
  verbEscaped: boolean;
};

function parseCliArgs(argv: string[]): ParsedArgs | number {
  setProfileOverride(undefined);

  let values: ParsedArgs["values"];
  let positionals: string[];
  let tokens: ReturnType<
    typeof parseArgs<{
      options: typeof PARSE_OPTIONS;
      strict: true;
      allowPositionals: true;
      tokens: true;
    }>
  >["tokens"];
  try {
    ({ values, positionals, tokens } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: PARSE_OPTIONS,
      tokens: true,
    }));
  } catch (err) {
    return usageError(messageOf(err));
  }

  const terminatorIndex = tokens.find((t) => t.kind === "option-terminator")?.index;
  const firstPositionalIndex = tokens.find((t) => t.kind === "positional")?.index;
  const verbEscaped =
    terminatorIndex !== undefined &&
    firstPositionalIndex !== undefined &&
    terminatorIndex < firstPositionalIndex;

  setProfileOverride(values.profile);

  const maxTurnsRaw = values["max-turns"];
  let maxTurns: number | undefined;
  if (maxTurnsRaw !== undefined) {
    // node:util parseArgs has no numeric option type, so `--max-turns abc` is accepted.
    if (!/^[1-9]\d*$/.test(maxTurnsRaw))
      return usageError(`Invalid --max-turns value: ${maxTurnsRaw}`);
    maxTurns = Number(maxTurnsRaw);
  }

  const promptChannel = parsePromptChannel(values["permission-prompts"]);
  if (typeof promptChannel === "object") return usageError(promptChannel.error);

  const { profile, source } = resolveProfile(values.profile);
  const profileError = profileNameError(profile);
  if (profileError !== undefined) {
    const named = source === "flag" ? "--profile" : "SERI_PROFILE";
    return usageError(`Invalid ${named} value: ${profile} — ${profileError}`);
  }

  if (values.resume !== undefined && commandByName(values.resume) !== undefined) {
    return usageError(
      `--resume ${values.resume} looks for a session named "${values.resume}". Slash commands only run inside the TUI: resume with seri --continue, then type ${values.resume}.`,
    );
  }

  return {
    values,
    positionals,
    maxTurns,
    skipPermissions: values["dangerously-skip-permissions"] === true,
    promptChannel,
    verbEscaped,
  };
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

async function runSelftest(deps: CliDeps): Promise<number> {
  try {
    const version = await probeRipgrep(deps.grep ?? grepReal);
    console.log(`selftest ok: ripgrep ${version}`);
    return 0;
  } catch (err) {
    console.error(messageOf(err));
    return 1;
  }
}

async function handleServeCommand(
  positionals: string[],
  deps: CliDeps,
): Promise<number | undefined> {
  if (positionals[0] !== "serve") return undefined;
  if (positionals.length !== 1) {
    return usageError("seri serve takes no arguments");
  }
  const configDir = deps.authConfigDir ?? getConfigDir();
  const start = deps.startDaemon ?? startDaemonReal;
  try {
    const daemon: StartedDaemon = await start({
      configDir,
      executeTurn: deps.executeTurn,
      runScheduled: deps.runScheduled,
      onIdleFlush: deps.onIdleFlush,
      deps,
    });
    console.log(`seri daemon listening on ${daemon.endpoint}`);
    try {
      if (deps.waitForServe !== undefined) await deps.waitForServe();
      else {
        process.removeAllListeners("SIGINT");
        process.removeAllListeners("SIGTERM");
        await new Promise<void>((resolve) => {
          process.once("SIGINT", () => resolve());
          process.once("SIGTERM", () => resolve());
        });
      }
    } finally {
      await daemon.stop();
    }
    return 0;
  } catch (err) {
    console.error(messageOf(err));
    return 1;
  }
}

async function handleExecCommand(
  positionals: string[],
  deps: CliDeps,
  promptChannel: PromptChannel,
): Promise<number | undefined> {
  if (positionals[0] !== "exec") return undefined;
  const task = positionals.slice(1).join(" ").trim();
  if (task.length === 0) return usageError("seri exec requires a task");
  const configDir = deps.authConfigDir ?? getConfigDir();
  const descriptor = readDaemonDescriptorFile(configDir);
  if (descriptor === undefined) {
    console.error("no daemon is running for this profile — start one with seri serve");
    return 1;
  }
  const client = new DaemonClient({
    endpoint: descriptor.endpoint,
    token: descriptor.token,
    fetch: deps.fetch,
  });
  let exitCode: 0 | 1 = 1;
  let turnId: string | undefined;
  let cancelRequested = false;
  const unregisterCancel = onSignalCancel(() => {
    cancelRequested = true;
    if (turnId !== undefined) void client.cancel(turnId).catch(() => {});
  });
  try {
    for await (const event of client.startTurn({
      task,
      cwd: process.cwd(),
      ...(promptChannel === "none" ? { permissionPrompts: "none" as const } : {}),
    })) {
      turnId = event.turnId;
      if (cancelRequested) {
        await client.cancel(turnId);
        cancelRequested = false;
      }
      if (event.event.type === "approval-request" && typeof event.event.requestId === "string") {
        await client.approve(turnId, event.event.requestId, "no");
        continue;
      }
      if (isLoopDaemonEvent(event.event)) printEvent(event.event.value as LoopEvent);
      if (event.event.type === "turn-complete" && "exitCode" in event.event) {
        const code = event.event.exitCode;
        if (code === 0 || code === 1) exitCode = code;
      }
    }
  } catch (err) {
    console.error(messageOf(err));
    return 1;
  } finally {
    unregisterCancel();
  }
  return exitCode;
}

async function handleDoctorCommand(
  positionals: string[],
  deps: CliDeps,
): Promise<number | undefined> {
  if (positionals[0] !== "doctor") return undefined;
  if (positionals.length !== 1) {
    return usageError("seri doctor takes no arguments");
  }
  const checks = await runDoctorChecks({
    grep: deps.grep ?? grepReal,
    fetch: deps.fetch ?? fetch,
    execPath: deps.execPath ?? process.execPath,
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    configDir: deps.authConfigDir ?? getConfigDir(),
  });
  printDoctorReport(checks);
  return doctorExitCode(checks);
}

async function handleUpdateCommand(
  positionals: string[],
  deps: CliDeps,
): Promise<number | undefined> {
  if (positionals[0] !== "update") return undefined;
  if (positionals.length !== 1) {
    return usageError("seri update takes no arguments");
  }
  const result = await runUpdate({
    fetch: deps.fetch ?? fetch,
    execPath: deps.execPath ?? process.execPath,
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    version: pkg.version,
    smoke: deps.smokeUpdate,
  });
  for (const line of result.lines) {
    if (result.code === 0) console.log(line);
    else console.error(line);
  }
  return result.code;
}

export type RunContext = CommandDirs & {
  resuming: boolean;
  resumeId: string | undefined;
  taskText: string;
  permissionsDir: string;
  cwd: string;
  database?: SessionDatabase;
};

function modelPairChanged(
  a: { model: string; provider: ModelProvider },
  b: { model: string; provider: ModelProvider },
): boolean {
  return a.model !== b.model || a.provider !== b.provider;
}

function pushTranscriptLine(
  dispatch: Dispatch,
  line: string,
  opts?: { muted?: boolean; markdown?: boolean },
): void {
  dispatch({ type: "transcript-append", line, muted: opts?.muted, markdown: opts?.markdown });
}

function withUserTurn(messages: ModelMessage[], content: string): ModelMessage[] {
  const last = messages[messages.length - 1];
  if (last?.role !== "user") return [...messages, { role: "user", content }];
  return [
    ...messages,
    { role: "assistant", content: [{ type: "text", text: "[interrupted]" }] },
    { role: "user", content },
  ];
}

export function tuiPresenter(
  dispatch: Dispatch,
  awaitPersist: () => Promise<void>,
  getSession: () => SessionState<ModelMessage>,
  onUsageAccrued: (usage: LanguageModelUsage) => void = () => {},
): CommandPresenter {
  const append = (line: string): void => pushTranscriptLine(dispatch, line);
  return {
    message: append,
    onPlan: (plan) => undoPlanLines(plan, append),
    restore: ({ plan, message }) => {
      append(message);
      if (plan.restored.length > 0 || plan.deleted.length > 0) recoveryLines(plan, append);
    },
    sessionUpdated: (next) => {
      const persisted = awaitPersist();
      dispatch({ type: "session-updated", session: next });
      return persisted;
    },
    transcriptCleared: () => dispatch({ type: "transcript-cleared" }),
    usageAccrued: onUsageAccrued,
    cancelled: () => append("Compaction cancelled."),
    currentSession: getSession,
  };
}

export function needsGuidedSetup(configDir: string): boolean {
  const configured = configuredProviders(configDir);
  const subscribed = subscribedProviders(configDir);
  if (configured.size === 0 && subscribed.size === 0 && !hostedPlanUsable(configDir)) {
    return true;
  }
  return !defaultPairPayable(configDir, configured, subscribed);
}

function hasAggregatorKey(configured: ReadonlySet<ModelProvider>): boolean {
  for (const provider of configured) {
    if (!NATIVE_PROVIDERS[provider]) return true;
  }
  return false;
}

function defaultPairPayable(
  configDir: string,
  configured: ReadonlySet<ModelProvider>,
  subscribed: ReadonlySet<ModelProvider>,
): boolean {
  if (hostedPlanUsable(configDir)) return true;
  const { provider } = resolveDefaultModel(configDir);
  const resolved = provider ?? DEFAULT_PROVIDER;
  if (configured.has(resolved) || subscribed.has(resolved)) return true;
  return provider === undefined && hasAggregatorKey(configured);
}

function checkZeroKeysConfigured(configDir: string): boolean | number {
  try {
    return needsGuidedSetup(configDir);
  } catch (err) {
    return fatalDuringTui(err);
  }
}

async function runTui(
  prepared: PreparedRun,
  ctx: RunContext,
  deps: CliDeps,
  maxTurns: number | undefined,
  skipPermissions: boolean,
  promptChannel: PromptChannel,
  queuedTask?: string,
): Promise<DriveLoopResult> {
  const configDir = deps.authConfigDir ?? getConfigDir();

  // @opentui/core createCliRenderer is async, unlike Ink's synchronous render.
  const { renderer, root } = await getTuiRenderer(configDir);

  const initialConfig = loadConfig(configDir);
  let liveState: TuiState = initialTuiState(prepared.session, {
    route: prepared.route,
    config: initialConfig,
  });
  let confirmedModel: { model: string; provider: ModelProvider } = {
    model: prepared.route.model,
    provider: prepared.route.provider,
  };
  let lastPersistedModel: { model: string; provider: ModelProvider } = {
    model: prepared.route.model,
    provider: prepared.route.provider,
  };
  let reactDispatch: Dispatch | undefined;
  const dispatch: Dispatch = (action) => {
    liveState = tuiReducer(liveState, action);
    reactDispatch?.(action);
  };
  const echoUserInput = (text: string): void => {
    dispatch({ type: "transcript-append", line: `> ${text.trim()}`, role: "user", flush: false });
    dispatch({ type: "command-error-cleared" });
  };
  let turnInFlight = false;
  let cancelDelivered = false;
  let queueIds = 0;
  const nextQueueId = (): string => `q${++queueIds}`;
  let currentTurn: Promise<void> = Promise.resolve();
  let quitting = false;

  let usage: RunUsage = { inputTokens: undefined, outputTokens: undefined };
  let cost: CostReport | undefined;
  let doneReason: DriveLoopResult["doneReason"];
  let refusedWithoutRunning = false;
  let archivist: ArchivistReport | undefined;
  let ranAnyTurn = false;
  let liveMaxTurns = maxTurns;
  let archivistState = createArchivistState(prepared.session);

  let pendingPersistResolvers: Array<{ resolve: () => void; reject: (err: unknown) => void }> = [];
  function awaitNextPersist(): Promise<void> {
    return new Promise((resolve, reject) => {
      pendingPersistResolvers.push({ resolve, reject });
    });
  }

  function onSessionChange(session: SessionState<ModelMessage>): void {
    const resolvers = pendingPersistResolvers;
    pendingPersistResolvers = [];
    const toPersist = {
      ...session,
      model: confirmedModel.model,
      provider: confirmedModel.provider,
    };
    try {
      saveSession(toPersist, ctx.sessionsDir, ctx.database);
    } catch (err) {
      const message = `could not save the session: ${messageOf(err)}`;
      dispatch({ type: "command-error", message });
      for (const { reject } of resolvers) reject(new Error(message));
      return;
    }
    for (const { resolve } of resolvers) resolve();
  }

  function getPermissionMode(): PermissionMode {
    if (isPlanOverlayOn(liveState.plan)) return "read-only";
    return skipPermissions ? "auto" : liveState.session.permissionMode;
  }

  let resolveRunTui!: (result: DriveLoopResult) => void;
  let rejectRunTui!: (err: Error) => void;
  const settled = new Promise<DriveLoopResult>((resolve, reject) => {
    resolveRunTui = resolve;
    rejectRunTui = reject;
  });

  let pendingApprovalResolve: ((answer: ApprovalAnswer) => void) | undefined;

  const askUserPark = createAskUserPark({
    dispatchOccupy: (prompt) => dispatch({ type: "ask-user-requested", prompt }),
    dispatchVacate: () => dispatch({ type: "ask-user-resolved" }),
    approvalOccupied: () => liveState.pendingApproval !== undefined,
  });

  function tuiApprovalPrompt(
    toolName: string,
    args: unknown,
    signal?: AbortSignal,
    detail?: ApprovalDetail,
  ): Promise<ApprovalAnswer> {
    return new Promise<ApprovalAnswer>((resolve) => {
      if (signal?.aborted === true) {
        resolve("no");
        return;
      }
      const offersAlways =
        isPersistableTool(toolName) &&
        locationForCall(liveState.session.cwd, toolName, args) !== "outside";
      const abort = onAbort(signal, () => {
        pendingApprovalResolve = undefined;
        dispatch({ type: "approval-resolved" });
        resolve("no");
      });
      pendingApprovalResolve = (answer) => {
        abort.dispose();
        resolve(answer);
      };
      dispatch({
        type: "approval-requested",
        toolName,
        args,
        offersAlways,
        ...(detail?.classifierReason !== undefined
          ? { classifierReason: detail.classifierReason }
          : {}),
      });
    });
  }

  let pendingPlanQuestionsResolve: ((answers: PlanAnswers) => void) | undefined;

  function tuiAskPlanQuestions(
    questions: readonly PlanQuestion[],
    signal?: AbortSignal,
  ): Promise<PlanAnswers> {
    return new Promise<PlanAnswers>((resolve) => {
      if (signal?.aborted === true) {
        resolve({ cancelled: true });
        return;
      }
      const abort = onAbort(signal, () => {
        pendingPlanQuestionsResolve = undefined;
        dispatch({ type: "plan-on" });
        resolve({ cancelled: true });
      });
      pendingPlanQuestionsResolve = (answers) => {
        abort.dispose();
        resolve(answers);
      };
      dispatch({ type: "plan-questions-requested", questions });
    });
  }

  function onPlanQuestionsAnswered(answers: PlanAnswers): void {
    const resolve = pendingPlanQuestionsResolve;
    if (resolve === undefined) return;
    pendingPlanQuestionsResolve = undefined;
    dispatch({ type: "plan-on" });
    resolve(answers);
  }

  function onPlanReview(decision: PlanReviewDecision): void {
    const plan = liveState.plan;
    if (plan.kind !== "reviewing") return;
    if (decision === "request-changes") {
      dispatch({ type: "plan-on" });
      return;
    }
    if (decision === "cancel") {
      unlinkPlanFile(plan.path, configDir);
      dispatch({ type: "plan-off" });
      drainQueue();
      return;
    }
    const prompt = `The user approved the plan "${plan.title}" at ${plan.path}. Implement it.\n\n${plan.markdown}`;
    dispatch({ type: "plan-off" });
    currentTurn = runTurn(
      {
        ...liveState.session,
        messages: withUserTurn(liveState.session.messages, prompt),
      },
      prompt,
    );
  }

  function onApprovalAnswer(answer: ApprovalAnswer): void {
    const resolve = pendingApprovalResolve;
    if (resolve === undefined) return;
    pendingApprovalResolve = undefined;
    dispatch({ type: "approval-resolved" });
    resolve(answer);
  }

  function onModelSelected(
    pick: { model: string; provider: ModelProvider; keyConfigured: boolean },
    leftoverInput?: string,
  ): void {
    const route = resolveSessionRoute(
      pick,
      prepared.catalog,
      configuredProviders(configDir),
      prepared.plan,
      configDir,
    );
    dispatch({ type: "model-picker-resolved", pick, leftoverInput, route });
  }

  function onModelPickerCancel(): void {
    dispatch({ type: "model-picker-resolved" });
  }

  function onCycleMode(): void {
    const { next } = decideModeCycle(liveState.session);
    tuiPresenter(dispatch, awaitNextPersist, () => liveState.session)
      .sessionUpdated(next)
      .catch((err: unknown) => dispatch({ type: "command-error", message: messageOf(err) }));
  }

  const { onLogin, onLogout, onAbandon, onConnectGrok, onConnectCodex } = createAuthHandlers({
    dispatch,
    deps,
    configDir,
  });

  const { onSetupSelect, onSetupKeyEntered, onSetupRemove, onSetupBack } = createSetupHandlers({
    dispatch,
    getPendingSetup: () => liveState.pendingSetup,
    configDir,
    onConnectGrok,
    onConnectCodex,
    onConnectSeri: () => onLogin("login"),
  });

  function onSetupClose(leftoverInput?: string): void {
    dispatch({ type: "setup-resolved", leftoverInput });
  }

  const { onConfigSelect, onConfigValueEntered, onConfigUnset, onConfigBack } =
    createConfigHandlers({
      dispatch,
      getPendingConfig: () => liveState.pendingConfig,
      configDir,
    });

  function onConfigClose(leftoverInput?: string): void {
    dispatch({ type: "config-resolved", leftoverInput });
  }

  const { onPermissionsRemove, onPermissionsBack } = createPermissionsHandlers({
    dispatch,
    getPendingPermissions: () => liveState.pendingPermissions,
    permissionsDir: ctx.permissionsDir,
    getWorktree: () => checkpointTarget(liveState.session, dirs(ctx)).worktree,
  });

  function onPermissionsClose(leftoverInput?: string): void {
    dispatch({ type: "permissions-resolved", leftoverInput });
  }

  async function onMcpConnect(
    name: string,
  ): Promise<{ ok: true; catalog: McpCatalog } | { ok: false; message: string }> {
    const entry = prepared.mcp.get(name);
    if (entry === undefined) return { ok: false, message: `No MCP server named "${name}".` };
    try {
      const dial = createSessionDial(configDir);
      return { ok: true, catalog: await fetchCatalog(entry.spec, undefined, dial) };
    } catch (err) {
      if (isAuthRequired(err)) {
        return { ok: false, message: `"${name}" needs authentication — press a to log in.` };
      }
      return { ok: false, message: messageOf(err) };
    }
  }

  let mcpAuthController: AbortController | undefined;

  async function onMcpAuth(name: string): Promise<McpLoginResult> {
    const entry = prepared.mcp.get(name);
    if (entry === undefined) {
      return { status: "error", message: `No MCP server named "${name}".` };
    }
    const controller = new AbortController();
    mcpAuthController = controller;
    return loginMcpServer(entry.spec, configDir, {
      signal: controller.signal,
      onMessage: (line) => dispatch({ type: "transcript-append", line }),
    });
  }

  function onMcpAuthCancel(): void {
    mcpAuthController?.abort();
  }

  function applyMcpChange(change: McpRegistryChange | undefined): void {
    if (change === undefined) return;
    if (change.kind === "added") prepared.mcp.set(change.entry.spec.name, change.entry);
    else prepared.mcp.delete(change.name);
  }

  function onMcpTrust(catalog: McpCatalog): void {
    writeCatalogCache(configDir, catalog);
    const toolCount = catalog.tools.length;
    dispatch({
      type: "transcript-append",
      line: `Trusted "${catalog.server}" and cached its ${toolCount} tool${toolCount === 1 ? "" : "s"}. It loads in the next session, or after /clear.`,
    });
  }

  function onMcpRemove(name: string): void {
    const worktree = checkpointTarget(liveState.session, dirs(ctx)).worktree;
    try {
      const { lines, change } = decideMcpCommand(["remove", name], {
        registry: prepared.mcp,
        configDir,
        worktree,
        clients: prepared.mcpClients,
      });
      for (const line of lines) {
        dispatch({ type: "transcript-append", line });
      }
      applyMcpChange(change);
      if (change !== undefined) {
        dispatch({
          type: "mcp-requested",
          rows: mcpPanelRows(prepared.mcp, prepared.mcpClients, worktree),
        });
      }
    } catch (err) {
      dispatch({ type: "command-error", message: messageOf(err) });
    }
  }

  const memoryDeps = { configDir };

  function onMemoryDiff(id: string): string[] {
    return memoryDiffLines(memoryDeps, id);
  }

  function onMemoryApprove(id: string): void {
    for (const line of decideMemoryCommand(["approve", id], memoryDeps).lines) {
      dispatch({ type: "transcript-append", line: line.text, muted: line.muted });
    }
    dispatch({ type: "memory-requested", rows: memoryPanelRows(memoryDeps) });
  }

  function onMemoryReject(id: string): void {
    for (const line of decideMemoryCommand(["reject", id], memoryDeps).lines) {
      dispatch({ type: "transcript-append", line: line.text, muted: line.muted });
    }
    dispatch({ type: "memory-requested", rows: memoryPanelRows(memoryDeps) });
  }

  const { onEffortSelected, onEffortCancel } = createEffortHandlers({ dispatch });

  const previewedSkillFiles = new Map<string, string>();

  const describeCompletion = (kind: string, description: string): string =>
    description.length === 0 ? kind : `${kind} · ${description}`;

  let completionSourceCache:
    | { agents: AgentRegistry; skills: SkillRegistry; sources: readonly CompletionSource[] }
    | undefined;
  const buildCompletionSources = (): readonly CompletionSource[] => {
    if (
      completionSourceCache !== undefined &&
      completionSourceCache.agents === prepared.agents &&
      completionSourceCache.skills === prepared.skills
    ) {
      return completionSourceCache.sources;
    }
    const sources: readonly CompletionSource[] = [
      {
        id: "commands",
        trigger: "/",
        lineStartOnly: true,
        items: [
          ...COMMAND_META.map((meta) => ({ name: meta.name, description: meta.description })),
          ...[...prepared.agents.values()].map((agent) => ({
            name: `/${agent.name}`,
            description: describeCompletion("subagent", agent.description),
          })),
          ...[...prepared.skills.values()].map((skill) => ({
            name: `/${skill.name}`,
            description: describeCompletion("skill", skill.description),
          })),
        ]
          .filter(
            (item, index, all) => all.findIndex((other) => other.name === item.name) === index,
          )
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((item) => ({ value: item.name, description: item.description })),
      },
    ];
    completionSourceCache = { agents: prepared.agents, skills: prepared.skills, sources };
    return sources;
  };

  async function runTurn(
    session: SessionState<ModelMessage>,
    inputText?: string,
    directDispatch?: { agent: AgentSpec; goal: string },
  ): Promise<void> {
    if (reactDispatch === undefined || turnInFlight) return;
    turnInFlight = true;
    ranAnyTurn = true;
    const { id: sessionId, provider: requestedProvider } = session as RunSession;
    let route: ResolvedRoute;
    let model: LanguageModel;
    let config: Record<string, string>;
    try {
      route = resolveSessionRoute(
        session,
        prepared.catalog,
        configuredProviders(configDir),
        prepared.plan,
        configDir,
      );
      model = dispatchModel(route, sessionId, configDir, deps);
      config = loadConfig(configDir);
    } catch (err) {
      dispatch({
        type: "command-error",
        message: tuiMissingKeyMessage(err),
      });
      turnInFlight = false;
      return;
    }
    const { model: modelId, provider } = route;
    dispatch({ type: "route-updated", route });
    dispatch({ type: "config-updated", config });
    dispatch({
      type: "turn-started",
      startedAt: Date.now(),
      inputEstimate: inputText === undefined ? 0 : estimateTokens(inputText),
    });
    dispatch({ type: "user-turn-committed", messages: session.messages });
    if (route.rerouted) {
      dispatch({
        type: "transcript-append",
        line: `↻ ${rerouteNotice(route, requestedProvider)}`,
      });
    } else if (
      route.credential === "gateway" &&
      requestedProvider !== undefined &&
      requestedProvider !== route.provider
    ) {
      dispatch({
        type: "transcript-append",
        line: `↻ ${gatewayNotice(route, requestedProvider)}`,
      });
    }
    const catalogEntry = findCatalogEntry(prepared.catalog, modelId, provider);
    if (
      session.reasoningEffort !== undefined &&
      appliedReasoningEffort(session.reasoningEffort, catalogEntry) === undefined
    ) {
      dispatch({
        type: "transcript-append",
        line: `↻ reasoning effort "${session.reasoningEffort}" isn't legal for the current model — this turn runs without it.`,
      });
    }
    const turnPrepared: PreparedRun = {
      ...prepared,
      session: session as RunSession,
      model,
      catalogEntry,
      route,
    };
    let persistAttemptedThisTurn = false;
    let reasoningEffortPersistAttemptedThisTurn = false;
    let failure: { err: unknown } | undefined;
    try {
      const result = await driveLoop(
        turnPrepared,
        ctx,
        deps,
        liveMaxTurns,
        (event) => {
          dispatch({ type: "loop-event", event });
          if (event.type === "messages-updated") {
            if (modelPairChanged(confirmedModel, { model: modelId, provider })) {
              confirmedModel = { model: modelId, provider };
            }
            if (
              !persistAttemptedThisTurn &&
              modelPairChanged(lastPersistedModel, { model: modelId, provider })
            ) {
              persistAttemptedThisTurn = true;
              try {
                persistDefaultModel({ model: modelId, provider }, configDir);
                lastPersistedModel = { model: modelId, provider };
              } catch (err) {
                const message = messageOf(err);
                printWarning(`could not save the default model: ${message}`);
              }
            }
            const appliedTier = appliedReasoningEffort(session.reasoningEffort, catalogEntry);
            const currentConfig = loadConfig(configDir);
            if (
              !reasoningEffortPersistAttemptedThisTurn &&
              appliedTier !== undefined &&
              appliedTier !== loadReasoningEffortConfig(currentConfig)
            ) {
              reasoningEffortPersistAttemptedThisTurn = true;
              try {
                persistDefaultReasoningEffort(appliedTier, configDir);
                dispatch({
                  type: "config-updated",
                  config: { ...currentConfig, SERI_REASONING_EFFORT: appliedTier },
                });
              } catch (err) {
                const message = messageOf(err);
                printWarning(`could not save the default reasoning effort: ${message}`);
              }
            }
          }
        },
        getPermissionMode,
        () => {},
        promptChannel === "live" ? tuiApprovalPrompt : undefined,
        archivistState,
        (payload) => dispatch({ type: "subagent-child-event", ...payload }),
        {
          directDispatch,
          planMode:
            directDispatch === undefined && liveState.plan.kind !== "off"
              ? { askQuestions: tuiAskPlanQuestions, configDir }
              : undefined,
          askUser: askUserPark.present,
        },
      );
      usage = {
        inputTokens: addTokens(usage.inputTokens, result.usage.inputTokens),
        outputTokens: addTokens(usage.outputTokens, result.usage.outputTokens),
      };
      cost = addCost(cost, result.cost);
      doneReason = result.doneReason;
      refusedWithoutRunning = result.refusedWithoutRunning;
      archivist = result.archivist;
      if (result.directSummary !== undefined) {
        pushTranscriptLine(dispatch, result.directSummary, { muted: true, markdown: true });
      }
      if (result.archivist) {
        pushTranscriptLine(dispatch, archivistStatsLine(result.archivist), { muted: true });
        for (const line of archivistStagedLines(result.archivist)) {
          pushTranscriptLine(dispatch, line, { muted: true });
        }
        if (result.archivist.summary !== undefined) {
          pushTranscriptLine(dispatch, result.archivist.summary, { muted: true, markdown: true });
        }
      }
      if (result.submittedPlan !== undefined) {
        dispatch({ type: "plan-review-requested", plan: result.submittedPlan });
      }
    } catch (err) {
      failure = { err };
    } finally {
      turnInFlight = false;
      cancelDelivered = false;
      askUserPark.answer({ outcome: "cancelled" });
      dispatch({ type: "turn-ended" });
      if (failure === undefined) drainQueue();
    }
    if (failure !== undefined) {
      destroyTuiRenderer();
      rejectRunTui(failure.err instanceof Error ? failure.err : new Error(String(failure.err)));
    }
  }

  async function quit(): Promise<void> {
    if (reactDispatch === undefined || quitting) return;
    quitting = true;
    if (liveState.queue.items.length > 0) {
      const discarded = liveState.queue.items.length;
      pushTranscriptLine(
        dispatch,
        `${discarded} queued message${discarded === 1 ? "" : "s"} discarded`,
        { muted: true },
      );
    }
    if (liveState.pendingApproval !== undefined) onApprovalAnswer("no");
    askUserPark.answer({ outcome: "cancelled" });
    if (liveState.plan.kind === "clarifying") onPlanQuestionsAnswered({ cancelled: true });
    // @opentui/core CliRenderer.destroy() is synchronous, unlike Ink's async waitUntilExit.
    const finishQuit = (): void => {
      destroyTuiRenderer();
      resolveRunTui({
        doneReason,
        cancelledBy: undefined,
        usage,
        cost,
        refusedWithoutRunning,
        archivist,
        directSummary: undefined,
        ranAnyTurn,
      });
    };
    if (turnInFlight) {
      flushSync(() =>
        pushTranscriptLine(dispatch, "quitting — cancelling the in-flight turn, Ctrl-C to force"),
      );
      await renderer.idle();
      deliverSignal("SIGINT");
      void currentTurn.then(finishQuit);
    } else {
      finishQuit();
    }
  }

  function onEscape(): void {
    if (!turnInFlight || cancelDelivered) return;
    cancelDelivered = true;
    deliverSignal("SIGINT");
  }

  type TuiHandler = (args: string[]) => void | Promise<void>;
  const tuiHandlers: Record<string, TuiHandler> = {
    "/exit": async () => {
      await quit();
    },
    "/model": async () => {
      try {
        prepared.catalog = await catalogForModelPicker(prepared.catalog, configDir);
        dispatch({
          type: "model-picker-requested",
          entries: decideModelPickerOpen(
            prepared.catalog,
            configuredProviders(configDir),
            (entry, group) =>
              gatewayCoverageInGroup(
                group,
                effectiveHostedPlan(configDir, prepared.plan),
                hostedPlanUsable(configDir),
              ) !== undefined,
            modelPickerSubscribedProviders(configDir, isCodexPlanCatalogApplied()),
          ),
        });
      } catch (err) {
        dispatch({
          type: "command-error",
          message: messageOf(err),
        });
      }
    },
    "/effort": async (args) => {
      try {
        if (args.length === 0) {
          const opened = decideEffortOpen(
            prepared.catalog,
            configDir,
            liveState.session,
            prepared.plan,
          );
          if (opened === null) {
            dispatch({
              type: "command-error",
              message: "This model has no reasoning-effort tiers available.",
            });
            return;
          }
          dispatch({ type: "effort-requested", tiers: opened.tiers, selected: opened.selected });
          return;
        }
        await applyEffortCommand(
          liveState.session,
          args,
          prepared.catalog,
          prepared.plan,
          configDir,
          tuiPresenter(dispatch, awaitNextPersist, () => liveState.session),
        );
      } catch (err) {
        dispatch({
          type: "command-error",
          message: messageOf(err),
        });
      }
    },
    "/setup": () => {
      try {
        dispatch({ type: "setup-requested", rows: decideSetupOpen(configDir) });
      } catch (err) {
        dispatch({
          type: "command-error",
          message: messageOf(err),
        });
      }
    },
    "/login": async () => {
      await onLogin("login");
      prepared.plan = await fetchAccountPlan(configDir);
    },
    "/signup": async () => {
      await onLogin("signup");
      prepared.plan = await fetchAccountPlan(configDir);
    },
    "/logout": async () => {
      await onLogout();
      prepared.plan = null;
    },
    "/config": () => {
      try {
        dispatch({ type: "config-requested", rows: decideConfigOpen(configDir) });
      } catch (err) {
        dispatch({
          type: "command-error",
          message: messageOf(err),
        });
      }
    },
    "/skills": (args) => {
      const deps = {
        configDir: ctx.configDir,
        worktree: checkpointTarget(liveState.session, dirs(ctx)).worktree,
        previewed: previewedSkillFiles,
      };
      const [sub] = args;
      if (sub === undefined || sub === "list") {
        dispatch({ type: "skills-requested", rows: skillsPanelRows(deps, prepared.skills) });
        return;
      }
      try {
        for (const line of decideSkillsCommand(args, deps).lines) {
          dispatch({ type: "transcript-append", line });
        }
      } catch (err) {
        dispatch({ type: "command-error", message: messageOf(err) });
      }
    },
    "/hooks": (args) => {
      try {
        for (const line of decideHooksCommand(args, {
          configDir: ctx.configDir,
          worktree: checkpointTarget(liveState.session, dirs(ctx)).worktree,
        }).lines) {
          dispatch({ type: "transcript-append", line });
        }
      } catch (err) {
        dispatch({ type: "command-error", message: messageOf(err) });
      }
    },
    "/memory": (args) => {
      const [sub] = args;
      if (sub === undefined || sub === "list") {
        dispatch({ type: "memory-requested", rows: memoryPanelRows({ configDir: ctx.configDir }) });
        return;
      }
      try {
        for (const line of decideMemoryCommand(args, { configDir: ctx.configDir }).lines) {
          dispatch({ type: "transcript-append", line: line.text, muted: line.muted });
        }
      } catch (err) {
        dispatch({ type: "command-error", message: messageOf(err) });
      }
    },
    "/mcp": (args) => {
      const deps = {
        registry: prepared.mcp,
        configDir: ctx.configDir,
        worktree: checkpointTarget(liveState.session, dirs(ctx)).worktree,
        clients: prepared.mcpClients,
      };
      const [sub, name] = args;
      if (sub === undefined || sub === "list") {
        dispatch({
          type: "mcp-requested",
          rows: mcpPanelRows(prepared.mcp, prepared.mcpClients, deps.worktree),
        });
        return;
      }
      if (sub === "auth" && name !== undefined) {
        void onMcpAuth(name).then((result) => {
          dispatch({ type: "transcript-append", line: mcpLoginLine(name, result) });
        });
        return;
      }
      try {
        const { lines, change } = decideMcpCommand(args, deps);
        for (const line of lines) {
          dispatch({ type: "transcript-append", line });
        }
        applyMcpChange(change);
      } catch (err) {
        dispatch({ type: "command-error", message: messageOf(err) });
      }
    },
    "/permissions": () => {
      try {
        dispatch({
          type: "permissions-requested",
          rows: decidePermissionsOpen(
            ctx.permissionsDir,
            checkpointTarget(liveState.session, dirs(ctx)).worktree,
            (message) => dispatch({ type: "command-error", message }),
          ),
        });
      } catch (err) {
        dispatch({
          type: "command-error",
          message: messageOf(err),
        });
      }
    },
    "/max-turns": (args) => {
      try {
        liveMaxTurns = decideMaxTurns(args);
        dispatch({
          type: "transcript-append",
          line: `Max turns set to ${liveMaxTurns} — takes effect on the next turn.`,
        });
      } catch (err) {
        dispatch({
          type: "command-error",
          message: messageOf(err),
        });
      }
    },
    "/usage": async (args) => {
      const detail = args[0] === "--detail";
      dispatch({ type: "chrome-requested", tab: "usage", detail });
      const generation = liveState.pendingChrome?.generation;
      if (generation === undefined) return;
      const result = await fetchUsageReport(configDir);
      if (liveState.pendingChrome?.generation !== generation) return;
      dispatch({ type: "chrome-loaded", generation, load: chromeLoadFromFetch(result) });
    },
    "/profile": (args) => {
      try {
        const { dir, name: profileName } = decideProfileCreate(args);
        const created = ensureOwnerOnlyDir(dir);
        dispatch({
          type: "transcript-append",
          line: `Profile directory ${dir} ${created ? "created" : "already exists"}. This does not switch the running session's profile — restart with --profile ${profileName} or SERI_PROFILE to use it.`,
        });
      } catch (err) {
        dispatch({
          type: "command-error",
          message: messageOf(err),
        });
      }
    },
    "/plan": (args) => {
      if (turnInFlight) {
        dispatch({
          type: "command-error",
          message: "A turn is already running; wait for it to finish before submitting another.",
        });
        return;
      }
      const task = args.join(" ").trim();
      if (task.length === 0) {
        if (liveState.plan.kind === "reviewing") {
          unlinkPlanFile(liveState.plan.path, configDir);
          dispatch({ type: "plan-off" });
          drainQueue();
          return;
        }
        dispatch({ type: liveState.plan.kind === "off" ? "plan-on" : "plan-off" });
        return;
      }
      if (liveState.plan.kind === "reviewing") {
        dispatch({
          type: "command-error",
          message: "/plan: approve or cancel the current plan first.",
        });
        return;
      }
      if (liveState.plan.kind === "off") dispatch({ type: "plan-on" });
      currentTurn = runTurn(
        {
          ...liveState.session,
          messages: withUserTurn(liveState.session.messages, task),
        },
        task,
      );
    },
  };
  assertTuiHandlers(tuiHandlers);

  function onTogglePlan(): void {
    tuiHandlers["/plan"]([]);
  }

  function drainQueue(): void {
    if (turnInFlight) return;
    if (quitting) return;
    if (liveState.plan.kind === "reviewing") return;
    if (liveState.queue.editing) return;
    const head = liveState.queue.items[0];
    if (head === undefined) return;
    dispatch({ type: "queue-head-taken" });
    void onSubmit(head.text, true);
  }

  async function onSubmit(value: string, fromDrain = false): Promise<void> {
    if (reactDispatch === undefined) return;
    if (liveState.queue.editing) {
      const edited = value.trim();
      dispatch(
        edited.length === 0
          ? { type: "queue-edit-cancelled" }
          : { type: "queue-edit-committed", text: value },
      );
      drainQueue();
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    const bangCommand = parseBangLine(trimmed);
    if (bangCommand !== undefined) {
      echoUserInput(value);
      const confinement = { available: probeConfinement() };
      const { allowUnsandboxedCommands } = loadSandboxConfig(configDir);
      const launch = resolveShellLaunch(
        "bang",
        { allowUnsandboxedCommands, root: liveState.session.cwd },
        confinement,
      );
      try {
        await submitBang(bangCommand, launch, defaultBangRunners(), liveState.session.cwd, {
          error: (message) => dispatch({ type: "command-error", message }),
          output: (text) => dispatch({ type: "transcript-append", line: text }),
        });
      } catch (err) {
        dispatch({ type: "command-error", message: messageOf(err) });
      }
      return;
    }
    const [name = "", ...args] = trimmed.split(/\s+/).filter(Boolean);
    const spec = commandByName(name);
    if (
      !fromDrain &&
      (turnInFlight || liveState.queue.items.length > 0 || liveState.plan.kind === "reviewing") &&
      startsATurn(name, trimmed, prepared)
    ) {
      dispatch({ type: "queue-appended", id: nextQueueId(), text: value });
      return;
    }
    echoUserInput(value);
    if (spec !== undefined && isTuiClaimed(spec)) {
      if (!spec.accepts(args)) {
        dispatch({ type: "command-error", message: `${name}: invalid arguments.` });
        return;
      }
      const handler = tuiHandlers[name];
      if (handler === undefined) {
        throw new Error(`tuiHandlers missing ${name}`);
      }
      await handler(args);
      return;
    }
    const command = SLASH_COMMANDS.get(name);
    if (command === undefined) {
      if (name.startsWith("/")) {
        const agent = prepared.agents.get(name.slice(1));
        const skill = agent === undefined ? prepared.skills.get(name.slice(1)) : undefined;
        if (agent === undefined && skill === undefined) {
          dispatch({ type: "command-error", message: `Unrecognized command: ${name}` });
          return;
        }
        if (skill !== undefined) {
          if (turnInFlight) {
            dispatch({
              type: "command-error",
              message:
                "A turn is already running; wait for it to finish before submitting another.",
            });
            return;
          }
          let prompt: string;
          try {
            prompt = substituteSkillArgs(readSkillBody(skill), trimmed.slice(name.length).trim());
          } catch (err) {
            dispatch({ type: "command-error", message: messageOf(err) });
            return;
          }
          dispatch({
            type: "transcript-append",
            line: `Skill loaded: ${skill.name}`,
            muted: true,
          });
          currentTurn = runTurn(
            {
              ...liveState.session,
              messages: withUserTurn(liveState.session.messages, prompt),
            },
            prompt,
          );
          return;
        }
        if (agent === undefined) return;
        const goal = trimmed.slice(name.length).trim();
        if (goal.length === 0) {
          dispatch({ type: "command-error", message: `${name}: usage ${name} <task>` });
          return;
        }
        if (turnInFlight) {
          dispatch({
            type: "command-error",
            message: "A turn is already running; wait for it to finish before submitting another.",
          });
          return;
        }
        currentTurn = runTurn(liveState.session, goal, { agent, goal });
        return;
      }
      if (turnInFlight) {
        dispatch({
          type: "command-error",
          message: "A turn is already running; wait for it to finish before submitting another.",
        });
        return;
      }
      currentTurn = runTurn(
        {
          ...liveState.session,
          messages: withUserTurn(liveState.session.messages, trimmed),
        },
        trimmed,
      );
      return;
    }
    if (!command.accepts(args)) {
      dispatch({ type: "command-error", message: `${name}: invalid arguments.` });
      return;
    }
    if (turnInFlight && command.mutatesRunState === true) {
      dispatch({
        type: "command-error",
        message: `${name}: can't run while a turn is in flight.`,
      });
      return;
    }
    if (command.mutatesRunState === true) turnInFlight = true;
    const sessionIdBeforeCommand = liveState.session.id;
    const foldUsage = (u: LanguageModelUsage): void => {
      usage = {
        inputTokens: addTokens(usage.inputTokens, u.inputTokens),
        outputTokens: addTokens(usage.outputTokens, u.outputTokens),
      };
    };
    try {
      if (command.needsSession === false) {
        await command.run(
          args,
          dirs(ctx, prepared.trajectory),
          tuiPresenter(dispatch, awaitNextPersist, () => liveState.session, foldUsage),
          deps,
        );
      } else {
        await command.run(
          liveState.session,
          args,
          dirs(ctx, prepared.trajectory),
          tuiPresenter(dispatch, awaitNextPersist, () => liveState.session, foldUsage),
          deps,
        );
      }
      if (name === "/rewind") {
        resetArchivistForRewind(archivistState, liveState.session.messages);
      }
    } catch (err) {
      dispatch({
        type: "command-error",
        message: messageOf(err),
      });
    } finally {
      if (command.mutatesRunState === true) turnInFlight = false;
      if (liveState.session.id !== sessionIdBeforeCommand) {
        try {
          archivistState = bindSession(
            prepared,
            liveState.session as RunSession,
            configDir,
            ctx.permissionsDir,
            printWarning,
          );
        } catch (err) {
          dispatch({
            type: "command-error",
            message: `session switched to ${liveState.session.id} but checkpointing could not be rebound; restart seri before making further edits: ${messageOf(err)}`,
          });
        }
      }
      // Windows can throw EPERM/EBUSY on the removal half after checkout already rewrote the worktree.
      if (name === "/undo" || name === "/restore") {
        try {
          prepared.checkpointer.invalidate();
        } catch (err) {
          dispatch({
            type: "command-error",
            message: `could not resync checkpointing after ${name}; the next mutating tool call will still take a fresh snapshot: ${messageOf(err)}`,
          });
        }
      }
      drainQueue();
    }
  }

  root.render(
    createElement(App, {
      session: prepared.session,
      route: prepared.route,
      catalog: prepared.catalog,
      config: initialConfig,
      splashBanner: {
        version: pkg.version,
        model: prepared.route.model,
        provider: prepared.route.provider,
        via: formatRouteLabelFromResolved(prepared.route),
        cwd: prepared.session.cwd,
        home: resolveUserHome(),
      },
      onSubmit,
      onSessionChange,
      onQuit: quit,
      onEscape,
      onApprovalAnswer,
      onAskUserAnswered: (reply: HumanReply) => askUserPark.answer(reply),
      onPlanQuestionsAnswered,
      onPlanReview,
      onModelSelected,
      onModelPickerCancel,
      onCycleMode,
      onTogglePlan,
      skipPermissions,
      confinementAvailable: probeConfinement(),
      onSetupSelect,
      onSetupKeyEntered,
      onSetupRemove,
      onSetupBack,
      onSetupClose,
      onConfigSelect,
      onConfigValueEntered,
      onConfigUnset,
      onConfigBack,
      onConfigClose,
      onPermissionsRemove,
      onPermissionsBack,
      onPermissionsClose,
      onEffortSelected,
      onEffortCancel,
      onSkillRun: (name: string) => {
        void onSubmit(`/${name}`);
      },
      onMcpConnect,
      onMcpTrust,
      onMcpRemove,
      onMcpAuth,
      onMcpAuthCancel,
      onMemoryDiff,
      onMemoryApprove,
      onMemoryReject,
      onChromeTab: (tab) => dispatch({ type: "chrome-tab", tab }),
      onChromeClose: (leftoverInput) => dispatch({ type: "chrome-closed", leftoverInput }),
      getCompletionSources: buildCompletionSources,
      onAuthResolved: () => {
        onAbandon();
        dispatch({ type: "auth-resolved" });
      },
      connectDispatch: (reducerDispatch: Dispatch) => {
        reactDispatch = reducerDispatch;
        for (const { text, stream } of prepared.preMountMessages) {
          dispatch({
            type: "transcript-append",
            line: text,
            muted: stream === "stdout",
          });
        }
        const start = runStart(ctx);
        if (start === "task") echoUserInput(ctx.taskText);
        const shouldRunTurn =
          start === "task" || (start === "resume" && awaitsReply(prepared.session.messages));
        if (shouldRunTurn) {
          currentTurn = runTurn(prepared.session, start === "task" ? ctx.taskText : undefined);
          if (queuedTask !== undefined) {
            dispatch({
              type: "command-error",
              message: `dropped the message typed while starting, because this run already had a task: ${queuedTask}`,
            });
          }
        } else if (queuedTask !== undefined) {
          void onSubmit(queuedTask);
        }
      },
    }),
  );

  return settled;
}

export async function run(argv: string[], deps: CliDeps = {}): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (typeof parsed === "number") return parsed;
  const { values, positionals, maxTurns, skipPermissions, promptChannel, verbEscaped } = parsed;

  const info = handleInfoFlags(values);
  if (info !== undefined) return info;

  if (values.selftest === true) return runSelftest(deps);

  const isTTY = deps.isTTY ?? false;

  const ctx: RunContext = {
    resuming: values.continue === true || values.resume !== undefined,
    resumeId: values.resume,
    taskText: positionals.join(" ").trim(),
    sessionsDir: deps.sessionsDir ?? join(getConfigDir(), "sessions"),
    checkpointsDir: deps.checkpointsDir ?? join(getConfigDir(), "checkpoints"),
    permissionsDir: deps.permissionsDir ?? getConfigDir(),
    configDir: deps.authConfigDir ?? getConfigDir(),
    cwd: process.cwd(),
  };

  if (runStart(ctx) === "idle" && !isTTY) {
    if (argv.length === 0) {
      console.log(USAGE);
      return 0;
    }
    return usageError("No task given.");
  }

  const serve = verbEscaped ? undefined : await handleServeCommand(positionals, deps);
  if (serve !== undefined) return serve;

  const exec = verbEscaped ? undefined : await handleExecCommand(positionals, deps, promptChannel);
  if (exec !== undefined) return exec;

  const doctor = verbEscaped ? undefined : await handleDoctorCommand(positionals, deps);
  if (doctor !== undefined) return doctor;

  const updated = verbEscaped ? undefined : await handleUpdateCommand(positionals, deps);
  if (updated !== undefined) return updated;

  const database = new SessionDatabase(configDirForStore(ctx.sessionsDir, "sessions"));
  ctx.database = database;
  try {
    database.importLegacySessions(ctx.sessionsDir);
    const trajectoriesDir = getTrajectoriesDir(ctx.configDir);
    if (database.configDir === configDirForStore(trajectoriesDir, "trajectories")) {
      database.importLegacyTrajectories(trajectoriesDir);
    }
    return await finishCliRun(ctx, deps, maxTurns, skipPermissions, promptChannel, isTTY);
  } finally {
    database.close();
  }
}

async function finishCliRun(
  ctx: RunContext,
  deps: CliDeps,
  maxTurns: number | undefined,
  skipPermissions: boolean,
  promptChannel: PromptChannel,
  isTTY: boolean,
): Promise<number> {
  prewarmModelCatalog();

  let queuedTask: string | undefined;

  if (isTTY) {
    try {
      await runWelcomeSplash(ctx.configDir, deps, (task) => {
        queuedTask = task;
      });
      const zeroKeysConfigured = checkZeroKeysConfigured(ctx.configDir);
      if (typeof zeroKeysConfigured === "number") return zeroKeysConfigured;
      if (zeroKeysConfigured) {
        await runGuidedSetup(ctx.configDir, getModelCatalog(undefined, undefined, ctx.configDir));
      }
    } catch (err) {
      return fatalDuringTui(err);
    }
  }

  const prepared: PreparedRun | number = await prepareSession(ctx, deps, skipPermissions, isTTY);
  if (typeof prepared === "number") return prepared;

  let runResult: DriveLoopResult;
  if (isTTY) {
    try {
      runResult = await runTui(
        prepared,
        ctx,
        deps,
        maxTurns,
        skipPermissions,
        promptChannel,
        queuedTask,
      );
    } catch (err) {
      return fatalDuringTui(err, prepared.preMountMessages);
    }
  } else {
    const start = runStart(ctx);
    const shouldRunTurn =
      start === "task" || (start === "resume" && awaitsReply(prepared.session.messages));
    if (shouldRunTurn) {
      runResult = await driveLoop(
        prepared,
        ctx,
        deps,
        maxTurns,
        printEvent,
        () => prepared.permissionMode,
        (session) => saveSession(session, ctx.sessionsDir, ctx.database),
        promptChannel === "live"
          ? makeApprovalPrompt(deps.createInterface, () => prepared.session.cwd)
          : undefined,
        createArchivistState(prepared.session),
      );
    } else {
      runResult = {
        doneReason: undefined,
        cancelledBy: undefined,
        usage: { inputTokens: undefined, outputTokens: undefined },
        cost: undefined,
        refusedWithoutRunning: false,
        archivist: undefined,
        directSummary: undefined,
        ranAnyTurn: false,
      };
    }
  }
  const { doneReason, cancelledBy, usage, cost, refusedWithoutRunning, archivist, ranAnyTurn } =
    runResult;

  destroyTuiRenderer();

  printUsage(usage);
  if (cost !== undefined) printCost(cost);
  if (archivist) console.log(archivistLine(archivist));

  if (cancelledBy !== undefined) raiseSignal(cancelledBy);

  return exitCodeFromDriveResult(runResult);
}

if (import.meta.main) {
  run(process.argv.slice(2), { isTTY: process.stdout.isTTY }).then((code) => process.exit(code));
}
