// The decide half of slash-command handling. Registration — names, accepts, shortcuts, which
// surface claims a name — lives in commandCatalog.ts. Each function here decides what happened
// and returns it, and prints nothing itself — no saveSession, no console.log/print*. That is
// what lets the same decision serve both the non-interactive path (console.log the message)
// and the TUI path (dispatch it into the live transcript) from one implementation, mirroring
// ApprovalPrompt's two-implementation shape.
//
// checkpointTarget is exported and reused by cli.ts's prepareSession — the one copy this module
// and cli.ts both call through to, rather than cli.ts keeping its own duplicate.
import { randomUUID } from "node:crypto";
import {
  filterCatalogEntries,
  groupRoutes,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelProvider,
} from "@seri/model-catalog";
import type { Plan } from "@seri/plans";
import type { ModelMessage } from "ai";
import { loadAgentsFile } from "../../agents/loadAgentsFile";
import { buildSystemPrompt } from "../../agents/systemPrompt";
import { loadAuthSession } from "../../auth/authStore";
import {
  findCodexBin,
  type CodexSetupStatus,
} from "../../auth/codexBin";
import { hasCodexSubscription, loadCodexAuth, readCodexAuthMode } from "../../auth/codexAuthStore";
import {
  appendBarrier,
  checkpointStoreDir,
  type RestorePlan,
  type RestoreResult,
  restoreCommit,
  rewindConversation,
  undoFiles,
} from "../../checkpoint/checkpoint";
import { projectRoot } from "../../checkpoint/shadowGit";
import { maskValue } from "../../config/commands";
import { configBoolean, loadConfig, resolveConfigValue } from "../../config/config";
import { isDefaultProfile, profileDir, profileNameError } from "../../config/paths";
import { cycleMode } from "../../gate/gate";
import { type HooksLoad, loadHookRegistry } from "../../hooks/registry";
import { loadGrants, PERSISTABLE_TOOL_NAMES } from "../../permissions/store";
import {
  allProviderKeyStates,
  configuredProviders,
  PROVIDER_API_KEY_NAMES,
} from "../../provider/keys";
import { resolveReasoningEffort } from "../../provider/reasoning";
import {
  byRoutePriority,
  resolveLegalReasoningTiers,
  resolveRoute,
  resolveSessionRoute,
} from "../../provider/routing";
import { loadRuleRegistry, type RuleRegistry } from "../../rules/registry";
import type { SessionState } from "../../session/session";
import { loadSkillRegistry, type SkillRegistry } from "../../skills/registry";
import type { TrajectoryWriter } from "../../trajectory/writer";

export type CommandDirs = {
  sessionsDir: string;
  checkpointsDir: string;
  configDir: string;
  trajectory?: TrajectoryWriter;
};

// The session records the directory seri was started in, which is not necessarily the project —
// resolving the root here rather than at each call site is what keeps the live run and the three
// restoring commands addressing the same store, since the key is derived from it.
export function checkpointTarget(
  session: SessionState<ModelMessage>,
  dirs: CommandDirs,
): { storeDir: string; worktree: string } {
  const worktree = projectRoot(session.cwd);
  return { storeDir: checkpointStoreDir(dirs.checkpointsDir, worktree), worktree };
}

function steps(args: string[]): number {
  return args[0] === undefined ? 1 : Number(args[0]);
}

// "decide", not "apply": named to match undoCommand/restoreCommand/rewindCommand/cycleModeCommand
// (cli.ts) calling these to DECIDE the outcome, then handing it to a presenter — and to stop
// colliding with checkpoint/shadowGit.ts's own `applyRestore`, a different function (performs the
// removal pass) that this file's own former `applyRestore` name was one import away from.
export function decideModeCycle(session: SessionState<ModelMessage>): {
  next: SessionState<ModelMessage>;
  message: string;
} {
  const next = { ...session, permissionMode: cycleMode(session.permissionMode) };
  return { next, message: `Session ${next.id}: permission mode is now ${next.permissionMode}` };
}

// A single picker row: the catalog entry itself, whether ITS OWN provider currently has a key
// (App.tsx's own "your key"/"no key" column), how many OTHER routes reach the same logical model
// (routes.ts's routeKey — the D1 grouping) so a keyed row can say "+N routes" instead of leaving
// the alternatives scattered elsewhere in a flat list, and — when this row has no key of its own —
// which specific sibling provider `resolveRoute` would actually send it to, if any.
export type ModelPickerEntry = {
  entry: ModelCatalogEntry;
  keyConfigured: boolean;
  alternatives: number;
  rerouteTo?: ModelProvider;
  // Not optional: decideModelPickerOpen (below) sets this unconditionally on every row via
  // `planCoverage(entry)`, which always returns a real boolean (its own default is `() => false`,
  // never `undefined`) — so every consumer gets a real boolean too, with no `undefined` case to
  // handle that can't actually occur.
  gatewayReachable: boolean;
};

// The decision half of /model, mirroring decideModeCycle's own pure, no-I/O shape: what to show,
// not how to show it or what happens once the user picks. `filterCatalogEntries` (already applied
// once when the catalog was built — catalog.ts's own mapRawCatalog) is re-applied here rather than
// trusted, so a picker built against a catalog from a different source (a future test fixture, or
// @seri/model-catalog changing what it bundles) can't silently offer a model with no tool-call
// support to select.
//
// Entries are grouped by route (routeKey/groupRoutes), and each group's
// members are emitted ADJACENTLY, ordered native-then-aggregator via `byRoutePriority` — the exact
// same tie-break `resolveRoute` (provider/routing.ts) uses to pick a reroute, so the picker reads
// in the order routing would actually choose rather than scattering a model's own routes through
// an otherwise-flat, ~350-row list. Groups themselves stay in first-appearance (catalog) order,
// same as `groupRoutes` already guarantees.
export function decideModelPickerOpen(
  catalog: ModelCatalog,
  configured: ReadonlySet<ModelProvider>,
  // Defaults to always-false so a caller that passes nothing sees the same picker as before this
  // predicate existed. cli.ts's /model handler passes a real predicate built from
  // planCoverage.ts's per-model coverage rule and the session's fetched plan. Per-model, not
  // per-provider: Free's zero-price rule varies per model within a provider, the same reason
  // apps/server/lib/quota.ts's own isZeroPriceModel is per-model. Takes the entry's own route
  // group too (this function already has it in hand from `groups`, one row below) so a real
  // predicate can call gatewayCoverageInGroup directly instead of re-deriving the same group via
  // routesFor's own O(catalog size) scan on every one of the ~350 rows this loop emits.
  planCoverage: (entry: ModelCatalogEntry, group: readonly ModelCatalogEntry[]) => boolean = () =>
    false,
): ModelPickerEntry[] {
  const groups = groupRoutes(filterCatalogEntries(catalog.entries));
  const rows: ModelPickerEntry[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort(byRoutePriority);
    // Computed once per GROUP, not per row: resolveRoute's rule 2 depends only on the group's
    // siblings and `configured`, never on which keyless member is asking, so every keyless row
    // in a group shares the same answer — and calling resolveRoute itself, through any one
    // keyless member as the "requested" pair, ties this display to the actual routing decision
    // instead of a hand-rolled second copy of its tie-break that could silently drift from it
    // (a per-row `ordered.find` re-deriving resolveRoute's own filter+sort rather than calling it
    // would be an O(n^2)-per-group re-derivation of one answer).
    const firstKeyless = ordered.find((candidate) => !configured.has(candidate.provider));
    const resolved =
      firstKeyless === undefined
        ? undefined
        : resolveRoute(
            catalog,
            { model: firstKeyless.id, provider: firstKeyless.provider },
            configured,
          );
    const rerouteTarget = resolved?.rerouted ? resolved.provider : undefined;
    for (const entry of ordered) {
      const keyConfigured = configured.has(entry.provider);
      rows.push({
        entry,
        keyConfigured,
        alternatives: group.length - 1,
        rerouteTo: keyConfigured ? undefined : rerouteTarget,
        gatewayReachable: planCoverage(entry, group),
      });
    }
  }
  return rows;
}

// Guided setup's own picker: every row here is one the user's own configured key serves. A
// keyless row that only reroutes is never
// shown, for two reasons: its target is already present as its own keyed row in this same list
// (`rerouteTo` is only ever set to a sibling that `decideModelPickerOpen` found configured, and
// that sibling is itself emitted as a `keyConfigured: true` row), so a keyless row adds no
// reachable outcome beyond bug surface; and a keyless row's model/provider pair can only be
// persisted and resolved correctly later if it is independently reachable in the LIVE catalog at
// actual routing time — a guarantee the picker's own catalog (a live+fallback merge) cannot make.
// A KEYED row has no such gap: `resolveRoute` (provider/routing.ts) returns a configured pick
// unchanged, before it ever looks the model up in any catalog — so a keyed row sourced from
// `catalogWithFallback`'s backfill is exactly as safe to persist as a live one.
export function decideGuidedModelPickerOpen(
  catalog: ModelCatalog,
  configured: ReadonlySet<ModelProvider>,
): ModelPickerEntry[] {
  const keyed = decideModelPickerOpen(catalog, configured).filter((row) => row.keyConfigured);
  // `alternatives` above is `decideModelPickerOpen`'s own group.length - 1, counted over the FULL
  // route group before this filter drops every keyless sibling — recomputed here over just the
  // rows this list actually shows, or a row could claim "+1 route" for a route this list never
  // renders (a keyless sibling elsewhere in the same group that got filtered out above).
  const shownGroups = groupRoutes(keyed.map((row) => row.entry));
  const shownAlternatives = new Map<ModelCatalogEntry, number>();
  for (const group of shownGroups.values()) {
    for (const entry of group) shownAlternatives.set(entry, group.length - 1);
  }
  return keyed.map((row) => ({ ...row, alternatives: shownAlternatives.get(row.entry) ?? 0 }));
}

// One row per provider — /setup's own table. `removable` is false only when config.json
// genuinely has nothing to unset for this provider — an env-sourced
// row IS removable when a config.json entry also sits underneath it (providerKeyState's own
// `hasConfigEntry`, independent of which source wins for display); only a row with no config
// entry at all (source "env" with nothing saved, or "unset") has nothing for /setup to remove
// (the panel states why, for the env case — App.tsx's own SetupPanel).
export type SetupKeyRow = {
  kind: "key";
  provider: ModelProvider;
  keyName: string;
  source: "env" | "config" | "unset";
  masked: string | undefined;
  removable: boolean;
  unusedBecause?: string;
};

export type SetupSubscriptionRow = {
  kind: "subscription";
  provider: "openai";
  status: CodexSetupStatus;
  removable: false;
};

export type SetupProviderRow = SetupKeyRow | SetupSubscriptionRow;

export function isSetupSubscriptionRow(row: SetupProviderRow): row is SetupSubscriptionRow {
  return row.kind === "subscription";
}

function codexSetupRow(): SetupSubscriptionRow {
  if (findCodexBin() === undefined) {
    return {
      kind: "subscription",
      provider: "openai",
      status: { status: "not-installed" },
      removable: false,
    };
  }
  const auth = loadCodexAuth();
  if (auth !== undefined && auth.authMode === "chatgpt") {
    return {
      kind: "subscription",
      provider: "openai",
      status: { status: "connected" },
      removable: false,
    };
  }
  const mode = readCodexAuthMode();
  if (mode !== undefined && mode !== "chatgpt") {
    return {
      kind: "subscription",
      provider: "openai",
      status: { status: "not-logged-in", reason: "api-key" },
      removable: false,
    };
  }
  return {
    kind: "subscription",
    provider: "openai",
    status: { status: "not-logged-in", reason: "no-auth" },
    removable: false,
  };
}

export function decideSetupOpen(configDir?: string): SetupProviderRow[] {
  const openaiSubscribed = hasCodexSubscription();
  const keys: SetupKeyRow[] = allProviderKeyStates(configDir).map((state) => ({
    kind: "key",
    provider: state.provider,
    keyName: state.keyName,
    source: state.source,
    masked: state.masked,
    removable: state.hasConfigEntry,
    unusedBecause:
      openaiSubscribed && state.provider === "openai" && state.source !== "unset"
        ? "unused because a ChatGPT plan is connected"
        : undefined,
  }));
  return [...keys, codexSetupRow()];
}

// The decide* functions below share the same contract as every decide* function above: recompute
// fresh from disk on every call, plain functions, no Ink import, no saveSession/console.log/print*,
// let a bad input throw for the caller's try/catch to turn into a command-error.

// /login and /signup's own non-blocking offer (AuthBanner, App.tsx): true iff no auth session is
// saved yet, so a first-run user sees the offer without it blocking anything they're already doing.
export function decideAuthOffer(configDir: string): boolean {
  return loadAuthSession(configDir) === undefined;
}

// One /config list row per known key, plus any other config.json key that isn't a provider API
// key — provider keys are entirely /setup's, not /config's. `masked` is the raw value when
// `secret` is false (neither of the two known keys is a secret — SERI_VERIFY_COMMAND might be
// "bun check", which a user should be able to read back, not see as asterisks) — only actually
// masked (maskValue's own output) when `secret` is true.
export type ConfigRowKind = { kind: "string" } | { kind: "boolean"; on: boolean };
export type ConfigRowBase = {
  key: string;
  masked: string;
  source: "config" | "env" | "unset";
  removable: boolean;
};
export type ConfigRow = ConfigRowBase & ConfigRowKind;

type ConfigKeyInfo = {
  label: string;
  description: string;
  kind: "boolean" | "string";
  // SERI_VERIFY_ENABLED/SERI_VERIFY_COMMAND are read once, at prepareSession's own
  // loadVerifyConfig() call (cli.ts), and baked into withVerification(...) for the lifetime of the
  // running process — a /config write to either lands in config.json correctly but has no effect
  // on the CURRENT session, only the next one.
  takesEffectNextRun: boolean;
};

// Human-readable label/description/kind for each key /config always shows, in this order,
// regardless of whether config.json has them — none of these are secrets, unlike an unrecognized
// key, which defaults to secret (conservative: an unknown key could be provider-shaped in spirit
// even though provider keys themselves are filtered out below). `KNOWN_CONFIG_KEYS` is derived
// from this object's own keys, not maintained as a second list, so a key can't exist in one and
// not the other.
// A Map, not an object literal keyed on user-supplied strings: SLASH_COMMANDS (cli.ts) already
// hit this exact hazard and its own fix was the container, not a guard on the lookup — a plain
// object inherits Object.prototype, so a hand-added key literally named "toString" or
// "constructor" would resolve to the inherited function instead of falling through to the
// unknown-key default, and decideConfigOpen (below) would report it as a known, unmasked key.
const CONFIG_KEY_INFO = new Map<string, ConfigKeyInfo>([
  [
    "SERI_VERIFY_ENABLED",
    {
      label: "Automatic verification",
      description: "Run the verify command after each file edit and show failures to the model.",
      kind: "boolean",
      takesEffectNextRun: true,
    },
  ],
  [
    "SERI_VERIFY_COMMAND",
    {
      label: "Verify command",
      // Kept to the same length budget as SERI_VERIFY_ENABLED's own description, just above (both
      // measured at 75 chars): ConfigPanel's `selectedDescription`
      // (routes/config/ConfigPanel.tsx) has a single-row budget in PANEL_CHROME_ROWS (format.ts)
      // with no wrap allowance, and a longer string here wraps to 2 rows on an 80-column
      // terminal — one row taller than the panel's own layout budget, pushing content below it
      // (bug found by review, confirmed reachable at the repo's own DEFAULT_COLUMNS=80).
      description: 'Shell command run to verify edits, e.g. "bun run check". Unset disables it.',
      kind: "string",
      takesEffectNextRun: true,
    },
  ],
  [
    "SERI_REASONING_EFFORT",
    {
      label: "Reasoning effort",
      description: "Default reasoning effort for models that support it (e.g. low, medium, high).",
      kind: "string",
      // Read fresh at request time (config.ts's loadReasoningEffortConfig), not baked into a
      // long-lived process the way SERI_VERIFY_ENABLED/SERI_VERIFY_COMMAND are — a /config write
      // to this key applies to the very next turn, same as SessionState.reasoningEffort itself.
      takesEffectNextRun: false,
    },
  ],
  [
    "SERI_TUI_BACKGROUND",
    {
      label: "Background color",
      // Same length budget as the two descriptions above (ConfigPanel's own single-row
      // `selectedDescription`, measured at 75 chars).
      description: "Hex ground the TUI paints, e.g. #141413. Unset keeps the terminal's own.",
      kind: "string",
      // The renderer is built once, at launch (tui/runtime/renderer.ts), and its background is
      // applied there — a /config write lands in config.json but paints nothing until next run.
      takesEffectNextRun: true,
    },
  ],
]);
export const KNOWN_CONFIG_KEYS = [...CONFIG_KEY_INFO.keys()];

// Pure lookup (no disk read) so ConfigEnterValue/ConfigPanel's confirm-unset step can show a
// key's label without widening ConfigPanelState with a field decideConfigOpen already computes
// for the list step. Also decideConfigOpen's own reader — one fallback (raw key/empty
// description/"string" kind for a hand-added key with no entry here), not two copies of it.
export function configKeyInfo(key: string): ConfigKeyInfo {
  return (
    CONFIG_KEY_INFO.get(key) ?? {
      label: key,
      description: "",
      kind: "string",
      takesEffectNextRun: false,
    }
  );
}

// Never listed by /config, even if present in config.json: the OAuth client id /login's device
// flow resolves live (auth/deviceFlow.ts) — an internal/advanced setting, not one a common
// /config user should see or change. (process.env never adds a row on its own — it only affects
// the source/value of a key already in the list below — so no separate env guard is needed
// here.) This is a display policy, not a lock: `seri config set SERI_WORKOS_CLIENT_ID <value>`
// (config/commands.ts) still writes it deliberately, for whoever needs the escape hatch.
const HIDDEN_CONFIG_KEYS = ["SERI_WORKOS_CLIENT_ID"];

// The decision half of /config, mirroring decideSetupOpen's own shape. Every key the "other
// keys" tail below must not emit: the two known keys (already shown, in their own fixed order),
// the hidden ones, and provider API keys (PROVIDER_API_KEY_NAMES) — /setup already owns those,
// and showing them here too would let /config unset a provider key /setup itself never offers to.
export function decideConfigOpen(configDir: string): ConfigRow[] {
  const config = loadConfig(configDir);
  const excludedKeys = new Set([
    ...KNOWN_CONFIG_KEYS,
    ...HIDDEN_CONFIG_KEYS,
    ...Object.values(PROVIDER_API_KEY_NAMES),
  ]);
  const otherKeys = Object.keys(config)
    .filter((key) => !excludedKeys.has(key))
    .sort();
  return [...KNOWN_CONFIG_KEYS, ...otherKeys].map((key) => {
    const hasConfigEntry = Object.hasOwn(config, key);
    // source and value come from ONE precedence read, same as provider/keys.ts's stateFromConfig
    // (which /setup itself is built on) — a version of this where `source` checked `!== undefined`
    // while the value read used `||` would let an env var deliberately set to "" report
    // `source: "env"` while the value shown was already config.json's; `resolveConfigValue` closes
    // that disagreement for both the boolean row (SERI_VERIFY_ENABLED) and the string row
    // (SERI_VERIFY_COMMAND), and
    // for any hand-added key, at once: a value nothing reads is never displayed as authoritative.
    const { value, source } = resolveConfigValue(key, config);
    // label/description are NOT carried on the row: configKeyInfo(key) is the single source of
    // truth for both, and every consumer (ConfigPanel.tsx's three steps) already has the key —
    // carrying a copy here just for the list step meant a fixture module (configRowFixture.ts)
    // existed solely to keep that copy from drifting out of sync with CONFIG_KEY_INFO.
    const kind = configKeyInfo(key).kind;
    // Not carried on the row either, same reasoning as label/description just above: `secret` is
    // just as pure a function of `key` (CONFIG_KEY_INFO.has(key)) and has no production reader —
    // it only ever picks which value `masked` computes to, right here.
    const secret = !CONFIG_KEY_INFO.has(key);
    const kindFields: ConfigRowKind =
      kind === "boolean" ? { kind: "boolean", on: configBoolean(value) } : { kind: "string" };
    return {
      key,
      masked: value === undefined ? "" : secret ? maskValue(value) : value,
      source,
      removable: hasConfigEntry,
      ...kindFields,
    };
  });
}

// One /permissions list row per PERSISTABLE_TOOL_NAMES member currently in effect for this
// worktree: a project-tier grant (rememberGrant's only write target) is "persisted" and
// removable; a global-tier grant (approved for every project, hand-edited or moved up by the
// user — rememberGrant never writes there) is "pre-approved" and not removable from here. A tool
// with no grant at all in either tier is omitted, not shown as a third state.
export type PermissionRow = {
  tool: string;
  source: "persisted" | "pre-approved";
  removable: boolean;
};

export function decidePermissionsOpen(
  configDir: string,
  worktree: string,
  onWarning?: (message: string) => void,
): PermissionRow[] {
  const grants = loadGrants(configDir, worktree, onWarning);
  const rows: PermissionRow[] = [];
  for (const tool of PERSISTABLE_TOOL_NAMES) {
    if (grants.project.includes(tool)) {
      rows.push({ tool, source: "persisted", removable: true });
    } else if (grants.global.includes(tool)) {
      rows.push({ tool, source: "pre-approved", removable: false });
    }
  }
  return rows;
}

// The decision half of /effort's own bare, no-argument (picker-opening) form — mirrors
// decideModelPickerOpen's/decideSetupOpen's own shape: computes what the panel needs and returns
// it, deciding nothing about presentation, matching every other panel's own decide/handlers
// pairing (createEffortHandlers, tui/state/handlers.ts). `null` means "no
// tiers to offer" (no reasoningOptions for the model this session is currently routed to) —
// cli.ts's own onSubmit interception turns that into a command-error instead of opening an empty
// picker. `configured` is derived internally from `configDir`, not threaded in by the caller,
// matching decideSetupOpen/decideConfigOpen's own "recompute fresh from disk, `configDir` in" shape.
export function decideEffortOpen(
  catalog: ModelCatalog,
  configDir: string,
  session: SessionState<ModelMessage>,
  plan: Plan | null,
): { tiers: string[]; selected: number } | null {
  const route = resolveSessionRoute(
    session,
    catalog,
    configuredProviders(configDir),
    plan,
    configDir,
  );
  const tiers = resolveLegalReasoningTiers(route, catalog);
  if (tiers.length === 0) return null;
  // Opens on whatever is CURRENTLY resolved (session override, else the config default) so the
  // slider doesn't always reset to the first tier — `indexOf` returns -1 for "unset" or a value
  // not in this route's own legal list (a stale value from a route since switched away from), and
  // Math.max(0, -1) is the same "first tier" fallback that case deserves.
  const current = resolveReasoningEffort(session, loadConfig(configDir));
  const selected = Math.max(0, tiers.indexOf(current ?? ""));
  return { tiers, selected };
}

// /max-turns's own decision: a single positive-integer argument, the same shape --max-turns
// already validates in cli.ts (identical regex, so a value valid on the command line is valid here
// too, and vice versa).
export function decideMaxTurns(args: string[]): number {
  const raw = args[0];
  if (args.length !== 1 || raw === undefined || !/^[1-9]\d*$/.test(raw)) {
    throw new Error("Usage: /max-turns <N>, where N is a positive integer");
  }
  return Number(raw);
}

export function decideTrajectoryCommand(
  args: string[],
  currentlyEnabled: boolean,
): { enabled?: boolean; message: string } {
  if (args.length === 0) {
    return {
      message: currentlyEnabled ? "Trajectory recording is on." : "Trajectory recording is off.",
    };
  }
  if (args.length !== 1 || (args[0] !== "on" && args[0] !== "off")) {
    throw new Error("Usage: /trajectory [on|off]");
  }
  const enabled = args[0] === "on";
  return {
    enabled,
    message: enabled ? "Trajectory recording is on." : "Trajectory recording is off.",
  };
}

// /profile new's own decision: validates the name and returns where its directory WOULD live —
// this function does not create it, that is the caller's job. Returns `name` alongside `dir`
// rather than making the caller reverse-engineer it via `basename(dir)`, which would be wrong
// for a non-default name that happens to collide with something odd in `dir`'s own path.
//
// "default" is rejected outright, not silently mapped onto the base config dir:
// `isDefaultProfile`/`profileDir` (config/paths.ts) fold "default" (or
// its case-insensitive spellings on win32/darwin) onto the base root with no `default/` segment
// — so `join(getBaseConfigDir(), name)`, the ORIGINAL implementation here, used to create an
// orphaned directory `--profile default` could never select. Folding it the same way `profileDir`
// does instead of rejecting it would fix the orphaned-directory bug but leave `/profile new
// default` as a confusing no-op ("already exists" for a directory the user never asked to check)
// — rejecting it is what makes the one profile name that can never be "created" say so plainly.
export function decideProfileCreate(args: string[]): { dir: string; name: string } {
  const [subcommand, name] = args;
  if (subcommand !== "new" || name === undefined || args.length !== 2) {
    throw new Error("Usage: /profile new <name>");
  }
  const error = profileNameError(name);
  if (error !== undefined) throw new Error(error);
  if (isDefaultProfile(name)) {
    throw new Error(`"${name}" is already the default profile — there is nothing to create`);
  }
  return { dir: profileDir(name), name };
}

// `onPlan` defaults to a no-op but is meant to be passed through from the caller's own presenter
// (cli.ts's CommandPresenter.onPlan) — undoFiles/restoreCommit call it synchronously with the
// diff/restored/deleted plan BEFORE the removal pass runs, which is what lets the console path
// restore output.ts's own documented guarantee ("printed before the restore happens, not after")
// instead of only being able to report the plan after the fact, from the final result.
export function decideUndo(
  session: SessionState<ModelMessage>,
  args: string[],
  dirs: CommandDirs,
  onPlan: (plan: RestorePlan) => void = () => {},
): { next: SessionState<ModelMessage>; plan: RestoreResult; message: string } {
  const stepCount = steps(args);
  const plan = undoFiles({
    ...checkpointTarget(session, dirs),
    sessionId: session.id,
    steps: stepCount,
    onPlan,
  });
  const message =
    plan.restored.length === 0 && plan.deleted.length === 0
      ? plan.preserved.length === 0
        ? `Already at checkpoint ${stepCount}; no file changed.`
        : `Already at checkpoint ${stepCount}; no file restored or deleted, but ${plan.preserved.length} file(s) preserved (no proof seri wrote them, or edited since).`
      : `Undid to checkpoint ${stepCount}.`;
  return { next: session, plan, message };
}

export function decideRestore(
  session: SessionState<ModelMessage>,
  args: string[],
  dirs: CommandDirs,
  onPlan: (plan: RestorePlan) => void = () => {},
): { next: SessionState<ModelMessage>; plan: RestoreResult; message: string } {
  const commit = args[0] ?? "";
  const plan = restoreCommit({
    ...checkpointTarget(session, dirs),
    sessionId: session.id,
    commit,
    onPlan,
  });
  const message =
    plan.restored.length === 0 && plan.deleted.length === 0
      ? plan.preserved.length === 0
        ? `Already at ${commit}; no file changed.`
        : `Already at ${commit}; no file restored or deleted, but ${plan.preserved.length} file(s) preserved (no proof seri wrote them, or edited since).`
      : `Restored ${commit}.`;
  return { next: session, plan, message };
}

export function decideRewind(
  session: SessionState<ModelMessage>,
  args: string[],
  dirs: CommandDirs,
): { next: SessionState<ModelMessage>; message: string; recordBarrier: () => boolean } {
  const { storeDir } = checkpointTarget(session, dirs);
  const { rewindTo } = rewindConversation({ storeDir, sessionId: session.id, steps: steps(args) });
  // Clamped, because an anchor can outlive the array it indexed: a previous /rewind truncated the
  // session and the messages that followed reused those indices. Slicing past the end is a silent
  // no-op, and reporting the anchor rather than the count would announce a truncation that never
  // happened.
  const kept = Math.min(rewindTo, session.messages.length);
  const dropped = session.messages.length - kept;
  const next = { ...session, messages: session.messages.slice(0, kept) };
  // Clamping only catches the anchors that are too LARGE, and those are the harmless ones. An
  // older anchor small enough to index the rebuilt array points at a DIFFERENT message: with
  // anchors [1,3,5,7] over nine messages, `/rewind 2` truncates to five, a resume appends five
  // more and records [6,8], and `/rewind 3` then reaches the stale 7 and slices to 7 — leaving an
  // assistant tool-call whose tool result was dropped, which is AI_MissingToolResultsError on the
  // next resume and the exact failure `rewindTo = messages.length - 1` exists to prevent. So a
  // rewind draws the same kind of line compaction does. Recorded only when something was actually
  // dropped: a no-op rewind invalidates nothing, and a barrier for it would throw away history
  // that is still good.
  //
  // NOT called here — a decision function has no persistence to sequence itself against (this
  // file's own header comment: "no saveSession, no console.log/print*"), and calling it here meant the barrier
  // could land BEFORE the truncated session was ever persisted, an ordering this file had
  // reversed from the original (pre-TUI) `rewindCommand`, which called `saveSession` first and
  // only then `appendBarrier`. Returned as a closure instead, for the caller (cli.ts's
  // rewindCommand) to call AFTER `presenter.sessionUpdated(next)` — restoring that same order, so
  // a barrier is never durably recorded while the truncation it describes still isn't.
  const recordBarrier = (): boolean => {
    if (dropped === 0) return false;
    appendBarrier(storeDir, session.id, "rewind");
    return true;
  };
  return {
    next,
    message: `Session ${next.id}: dropped ${dropped} message(s), ${kept} remain. No file was touched.`,
    recordBarrier,
  };
}

// /clear's own decision: mints a brand-new session id and an empty transcript, carrying
// cwd/permissionMode/model/provider over verbatim rather than re-resolving them — re-resolving
// those would mean re-running loadOrCreateSession's new-session logic (hard-coding
// permissionMode: "approve-each" and re-running model resolution), discarding a /mode or model
// change the user made this session. `systemPrompt` is the one field NOT carried over: like
// loadOrCreateSession's own new-session and resume paths, it is rebuilt from the session's `cwd` on
// every /clear so an AGENTS.md edited since is picked up, rather than replaying a prompt from
// before the edit for the rest of the process. Not pure in the sense of "no I/O" — it's a
// filesystem read whose result depends on external state, same as loadOrCreateSession's own
// rebuild — but still side-effect-free: no checkpointTarget call, no persistence, the caller
// decides what to do with `next`, same contract as decideModeCycle above.
//
// `loadAgents` defaults to the real `loadAgentsFile`, matching `newId`'s own default-with-override
// shape on this exact signature — unlike `loadOrCreateSession`'s `loadAgentsFileFn` (threaded from
// `deps.loadAgentsFile` through `run()`), this override is reachable only by a caller of
// `decideClear` directly (this file's own tests), not through `run()`'s own dependency injection:
// `clearCommand`'s signature is fixed by `SlashCommand.run`, shared with every other command, so
// widening it (or `CommandDirs`) for this one caller was judged not worth it here.
export function decideClear(
  session: SessionState<ModelMessage>,
  configDir: string,
  newId: string = randomUUID(),
  loadAgents: typeof loadAgentsFile = loadAgentsFile,
  // Injected on the same terms `loadAgents` is, and for the same reason: /clear mints a
  // conceptually new session, so every part of it that was discovered from disk is rediscovered
  // rather than carried over. A skill directory added since the session started is live after
  // /clear. Warnings are dropped here rather than surfaced — bindSession reloads the identical set
  // moments later with a real sink attached, and printing each one twice is worse than printing it
  // once. `hooks` is loaded and not read: only skills and rules reach the prompt below. It stays in
  // the seam anyway because splitting it out would leave a caller free to stub two of the three and
  // still hit real disk for the third, which is the one bug this injection point exists to remove.
  loadExtensions: (cwd: string) => {
    skills: SkillRegistry;
    rules: RuleRegistry;
    hooks: HooksLoad;
  } = (cwd) => ({
    skills: loadSkillRegistry({ worktree: cwd, configDir, onWarning: () => {} }),
    rules: loadRuleRegistry({ worktree: cwd, configDir, onWarning: () => {} }),
    hooks: loadHookRegistry({ worktree: cwd, configDir, onWarning: () => {} }),
  }),
): { next: SessionState<ModelMessage>; message: string } {
  const extensions = loadExtensions(session.cwd);
  const next = {
    ...session,
    id: newId,
    messages: [],
    systemPrompt: buildSystemPrompt({
      agentsContent: loadAgents(session.cwd),
      skills: [...extensions.skills.values()],
      rules: [...extensions.rules.values()],
    }),
  };
  // "saved", not "intact": the checkpoint store retains only a fixed number of recent session refs
  // (checkpoint.ts's own pruneSessions), so repeated /clear in one long-lived process can prune an
  // earlier /clear'd-away session's checkpoint log before its .jsonl transcript ages out — the
  // transcript is the guarantee this message can actually make.
  const message = `Started a new session ${next.id}. The previous session is saved — resume it with: seri --resume ${session.id}`;
  return { next, message };
}
