// One session's MCP config, trust, listings, and connections.
// A tool reaches the model only when its remote name is in the trust ledger.
// A live listing supplies description and inputSchema for those names, and can drop one.
// Only trust() adds a name. A fingerprint change of an already-trusted name writes that
// name's new schema through the catalog. Arrivals and removals are not written.
import { messageOf } from "../errors";
import type { ToolSpawnEnv } from "../tools/toolSpawnEnv";
import {
  closeMcpClients,
  createMcpClients,
  type DialFn,
  dialPooledClient,
  isAuthRequired,
  type McpClientHandle,
  type McpClients,
  type McpPoolKey,
  type McpServerStatus,
  mcpPoolKey,
  type RemoteTool,
  toToolInfo,
} from "./client";
import { loadMcpRegistry, toolFingerprint, writeCatalogCache } from "./registry";
import type {
  McpCatalog,
  McpEntry,
  McpRegistry,
  McpServerSpec,
  McpToolInfo,
  McpTrustedTool,
} from "./types";

export const MCP_RELIST_TIMEOUT_MS = 2_000;

const MCP_CLOSE_TIMEOUT_MS = 5_000;

export type McpStore = {
  load(onWarning: (message: string) => void): McpRegistry;
  writeTrust(catalog: McpCatalog): void;
};

export function diskMcpStore(opts: {
  worktree: string;
  configDir: string;
  env: ToolSpawnEnv;
}): McpStore {
  return {
    load: (onWarning) => loadMcpRegistry({ ...opts, onWarning }),
    writeTrust: (catalog) => writeCatalogCache(opts.configDir, catalog),
  };
}

/** For runs with no MCP surface. Trust is unreachable there. */
export const EMPTY_MCP_STORE: McpStore = {
  load: () => new Map(),
  writeTrust: () => {
    throw new Error("this run has no MCP configuration to trust");
  },
};

export type McpUnavailableReason = "dropped" | "untrusted" | "removed" | "stale-turn";

export type McpServerSummary = {
  readonly spec: McpServerSpec;
  readonly trusted: boolean;
  readonly trustedToolCount: number | undefined;
  readonly awaitingReview: readonly string[];
  readonly status: McpServerStatus;
};

export type McpTurn = {
  readonly tools: readonly McpTrustedTool[];
  /** Composed names exposed earlier this session and absent from `tools`. */
  readonly withdrawn: readonly string[];
  readonly notices: readonly string[];
  call(
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<string>;
};

export type McpHost = {
  beginTurn(signal: AbortSignal | undefined): Promise<McpTurn>;
  tools(): readonly McpTrustedTool[];
  servers(): readonly McpServerSummary[];
  trust(catalog: McpCatalog): void;
  reload(): void;
  close(onWarning: (message: string) => void): Promise<void>;
};

type Listing = {
  readonly stamp: number;
  readonly byRemoteName: ReadonlyMap<string, RemoteTool>;
};

type ServerJudgement = {
  readonly exposed: readonly McpTrustedTool[];
  readonly added: readonly string[];
  readonly dropped: readonly string[];
};

type View = {
  readonly byName: ReadonlyMap<string, McpTrustedTool>;
  readonly sorted: readonly McpTrustedTool[];
  readonly byServer: ReadonlyMap<string, ServerJudgement>;
};

type Withdrawal = { readonly server: string; readonly reason: McpUnavailableReason };

const EMPTY_JUDGEMENT: ServerJudgement = { exposed: [], added: [], dropped: [] };

const UNAVAILABLE: Record<McpUnavailableReason, (tool: string, server: string) => string> = {
  dropped: (tool, server) =>
    `MCP tool "${tool}" was removed: server "${server}" no longer offers it. Do not call it again.`,
  untrusted: (tool, server) =>
    `MCP tool "${tool}" is unavailable: server "${server}" changed its URL or headers since the user trusted it, ` +
    `so none of its tools run until the user reviews it in /mcp. Do not retry this call.`,
  removed: (tool, server) =>
    `MCP tool "${tool}" was removed: the user removed server "${server}" from this session. Do not call it again.`,
  "stale-turn": (tool, server) =>
    `MCP tool "${tool}" changed on server "${server}" during this turn. It was not run. Call it again on the next turn.`,
};

function unavailableMessage(toolName: string, why: Withdrawal | undefined): string {
  return why === undefined
    ? `no MCP tool named "${toolName}" is available this session`
    : UNAVAILABLE[why.reason](toolName, why.server);
}

function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function expose(server: string, info: McpToolInfo): McpTrustedTool {
  return { ...info, server, fingerprint: toolFingerprint(info) };
}

function judgeServer(entry: McpEntry, listing: Listing | undefined): ServerJudgement {
  if (entry.catalog === undefined) return EMPTY_JUDGEMENT;
  const trusted = entry.catalog.tools;
  if (listing === undefined) {
    return {
      exposed: trusted.map((tool) => expose(entry.spec.name, tool)),
      added: [],
      dropped: [],
    };
  }
  const trustedNames = new Set(trusted.map((tool) => tool.name));
  const exposed: McpTrustedTool[] = [];
  const dropped: string[] = [];
  for (const tool of trusted) {
    const live = listing.byRemoteName.get(tool.name);
    if (live === undefined) {
      dropped.push(tool.name);
      continue;
    }
    // The stored toolName stays. The listing supplies the bytes the model and the grant see.
    const info: McpToolInfo = { ...toToolInfo(entry.spec.name, live), toolName: tool.toolName };
    exposed.push(expose(entry.spec.name, info));
  }
  const added: string[] = [];
  for (const name of listing.byRemoteName.keys()) {
    if (!trustedNames.has(name)) added.push(name);
  }
  return { exposed, added, dropped };
}

function deriveView(registry: McpRegistry, listings: ReadonlyMap<McpPoolKey, Listing>): View {
  const byName = new Map<string, McpTrustedTool>();
  const byServer = new Map<string, ServerJudgement>();
  for (const entry of registry.values()) {
    const judgement = judgeServer(entry, listings.get(mcpPoolKey(entry.spec)));
    byServer.set(entry.spec.name, judgement);
    for (const tool of judgement.exposed) {
      if (!byName.has(tool.toolName)) byName.set(tool.toolName, tool);
    }
  }
  const sorted = [...byName.values()].sort((a, b) => compareCodeUnit(a.toolName, b.toolName));
  return { byName, sorted, byServer };
}

function reasonGone(server: string, registry: McpRegistry): McpUnavailableReason {
  const entry = registry.get(server);
  if (entry === undefined) return "removed";
  if (entry.catalog === undefined) return "untrusted";
  return "dropped";
}

function sortedNames(names: readonly string[]): string[] {
  return [...names].sort(compareCodeUnit);
}

function reviewNotices(prev: View, next: View): string[] {
  const lines: string[] = [];
  for (const [server, judgement] of next.byServer) {
    const before = prev.byServer.get(server);
    const prevAdded = new Set(before?.added ?? []);
    const fresh = sortedNames(judgement.added.filter((name) => !prevAdded.has(name)));
    if (fresh.length > 0) {
      const n = fresh.length;
      lines.push(
        `MCP server "${server}" offers ${n} new tool${n === 1 ? "" : "s"} (${fresh.join(", ")}). The model cannot use them until you review them in /mcp.`,
      );
    }
    const prevDropped = new Set(before?.dropped ?? []);
    for (const name of sortedNames(judgement.dropped.filter((name) => !prevDropped.has(name)))) {
      lines.push(`MCP server "${server}" no longer offers ${name}.`);
    }
    const prevByRemote = new Map((before?.exposed ?? []).map((tool) => [tool.name, tool]));
    for (const tool of [...judgement.exposed].sort((a, b) => compareCodeUnit(a.name, b.name))) {
      const prior = prevByRemote.get(tool.name);
      if (prior !== undefined && prior.fingerprint !== tool.fingerprint) {
        lines.push(
          `MCP server "${server}" updated ${tool.name}. You will be asked again before it runs.`,
        );
      }
    }
  }
  return lines;
}

function emptyView(): View {
  return { byName: new Map(), sorted: [], byServer: new Map() };
}

async function closeBounded(close: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      close,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createMcpHost(opts: {
  store: McpStore;
  dial: DialFn;
  onWarning: (message: string) => void;
  relistTimeoutMs?: number;
}): McpHost {
  const relistTimeoutMs = opts.relistTimeoutMs ?? MCP_RELIST_TIMEOUT_MS;
  const clients: McpClients = createMcpClients(opts.dial);
  let registry: McpRegistry = new Map();
  const listings = new Map<McpPoolKey, Listing>();
  const withdrawn = new Map<string, Withdrawal>();
  const warned = new Set<string>();
  const newestIssued = new Map<McpPoolKey, number>();
  let stamp = 0;
  let view: View = emptyView();
  let lastTurnView: View = view;

  function recompute(): void {
    const next = deriveView(registry, listings);
    for (const [name, tool] of view.byName) {
      if (!next.byName.has(name)) {
        withdrawn.set(name, { server: tool.server, reason: reasonGone(tool.server, registry) });
      }
    }
    for (const name of next.byName.keys()) withdrawn.delete(name);
    view = next;
  }

  function persistListedSchema(key: McpPoolKey): void {
    let matched: McpEntry | undefined;
    for (const entry of registry.values()) {
      if (mcpPoolKey(entry.spec) === key) {
        matched = entry;
        break;
      }
    }
    const catalog = matched?.catalog;
    const listing = listings.get(key);
    if (matched === undefined || catalog === undefined || listing === undefined) return;
    let changed = false;
    const tools = catalog.tools.map((tool) => {
      const live = listing.byRemoteName.get(tool.name);
      if (live === undefined) return tool;
      const next = { ...toToolInfo(matched.spec.name, live), toolName: tool.toolName };
      if (toolFingerprint(next) !== toolFingerprint(tool)) changed = true;
      return next;
    });
    if (!changed) return;
    const nextCatalog: McpCatalog = {
      server: catalog.server,
      identity: catalog.identity,
      fetchedAt: new Date().toISOString(),
      tools,
    };
    opts.store.writeTrust(nextCatalog);
    const nextRegistry = new Map(registry);
    nextRegistry.set(matched.spec.name, { spec: matched.spec, catalog: nextCatalog });
    registry = nextRegistry;
  }

  function observe(key: McpPoolKey, issued: number, remote: readonly RemoteTool[]): boolean {
    // Request order, not arrival order. A slow reply must not overwrite a newer list.
    if ((listings.get(key)?.stamp ?? -1) >= issued) return false;
    const byRemoteName = new Map<string, RemoteTool>();
    for (const tool of remote) byRemoteName.set(tool.name, tool);
    listings.set(key, { stamp: issued, byRemoteName });
    recompute();
    persistListedSchema(key);
    return true;
  }

  function detach(key: McpPoolKey): void {
    const slot = clients.handles.get(key);
    if (slot === undefined) return;
    clients.handles.delete(key);
    void closeBounded(
      slot.handle.then((handle) => handle.close()),
      MCP_CLOSE_TIMEOUT_MS,
    ).catch((err: unknown) => {
      opts.onWarning(`could not close MCP server "${slot.server}": ${messageOf(err)}`);
    });
  }

  function reload(): void {
    registry = opts.store.load((message) => {
      if (warned.has(message)) return;
      warned.add(message);
      opts.onWarning(message);
    });
    const trustedKeys = new Set<McpPoolKey>();
    const entryKeys = new Set<McpPoolKey>();
    for (const entry of registry.values()) {
      const key = mcpPoolKey(entry.spec);
      entryKeys.add(key);
      if (entry.catalog !== undefined) trustedKeys.add(key);
    }
    for (const key of [...clients.handles.keys()]) {
      if (!trustedKeys.has(key)) detach(key);
    }
    for (const key of [...listings.keys()]) {
      if (!entryKeys.has(key)) listings.delete(key);
    }
    for (const name of [...clients.status.keys()]) {
      const entry = registry.get(name);
      if (entry === undefined || entry.catalog === undefined) {
        clients.status.delete(name);
        continue;
      }
      const state = clients.status.get(name);
      if (state?.state === "connected" && !clients.handles.has(mcpPoolKey(entry.spec))) {
        clients.status.delete(name);
      }
    }
    recompute();
  }

  function connect(spec: McpServerSpec, signal: AbortSignal | undefined): Promise<McpClientHandle> {
    const key = mcpPoolKey(spec);
    if (clients.handles.has(key)) return dialPooledClient(clients, spec, signal);
    const issued = ++stamp;
    return dialPooledClient(clients, spec, signal, (tools) => {
      observe(key, issued, tools);
    });
  }

  async function relist(key: McpPoolKey, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return;
    const slot = clients.handles.get(key);
    if (slot === undefined) return;
    const issued = ++stamp;
    newestIssued.set(key, issued);
    let handle: McpClientHandle;
    try {
      handle = await slot.handle;
    } catch {
      return;
    }
    if (clients.handles.get(key) !== slot) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const listPromise = handle.listTools();
      void listPromise.then(
        (tools) => {
          if (clients.handles.get(key) !== slot) return;
          if (observe(key, issued, tools)) {
            clients.status.set(slot.server, { state: "connected", toolCount: tools.length });
          }
        },
        (err: unknown) => {
          if (newestIssued.get(key) !== issued) return;
          if (signal?.aborted) return;
          if (clients.handles.get(key) !== slot) return;
          clients.handles.delete(key);
          clients.status.set(
            slot.server,
            isAuthRequired(err)
              ? { state: "needs-auth" }
              : { state: "failed", message: messageOf(err) },
          );
          // The listing stays. The next call dials again, which is reconnect.
          void closeBounded(handle.close(), MCP_CLOSE_TIMEOUT_MS).catch((closeErr: unknown) => {
            opts.onWarning(`could not close MCP server "${slot.server}": ${messageOf(closeErr)}`);
          });
        },
      );

      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), relistTimeoutMs);
      });
      const racers: Promise<"listed" | "rejected" | "timeout" | "aborted">[] = [
        listPromise.then(
          () => "listed" as const,
          () => "rejected" as const,
        ),
        timeout,
      ];
      if (signal !== undefined) {
        racers.push(
          new Promise<"aborted">((resolve) => {
            if (signal.aborted) resolve("aborted");
            else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
          }),
        );
      }
      await Promise.race(racers);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function relistConnected(signal: AbortSignal | undefined): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const entry of registry.values()) {
      if (entry.catalog === undefined) continue;
      if (clients.status.get(entry.spec.name)?.state !== "connected") continue;
      const key = mcpPoolKey(entry.spec);
      if (!clients.handles.has(key)) continue;
      jobs.push(relist(key, signal));
    }
    await Promise.all(jobs);
  }

  function assertStill(pinned: McpTrustedTool): void {
    const live = view.byName.get(pinned.toolName);
    if (live === undefined) {
      throw new Error(unavailableMessage(pinned.toolName, withdrawn.get(pinned.toolName)));
    }
    if (live.fingerprint !== pinned.fingerprint) {
      throw new Error(
        unavailableMessage(pinned.toolName, { server: pinned.server, reason: "stale-turn" }),
      );
    }
  }

  async function callAgainst(
    frozen: View,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const pinned = frozen.byName.get(toolName);
    if (pinned === undefined) {
      throw new Error(unavailableMessage(toolName, withdrawn.get(toolName)));
    }
    assertStill(pinned);
    const entry = registry.get(pinned.server);
    if (entry === undefined) {
      throw new Error(
        unavailableMessage(
          toolName,
          withdrawn.get(toolName) ?? { server: pinned.server, reason: "removed" },
        ),
      );
    }
    let handle: McpClientHandle;
    try {
      handle = await connect(entry.spec, signal);
    } catch (err) {
      if (isAuthRequired(err)) {
        throw new Error(
          `MCP server "${entry.spec.name}" needs authentication. Run /mcp auth ${entry.spec.name}.`,
        );
      }
      throw new Error(`MCP server "${entry.spec.name}" is unreachable: ${messageOf(err)}`);
    }
    assertStill(pinned);
    try {
      return await handle.callTool(pinned.name, args, { signal });
    } catch (err) {
      throw new Error(
        `MCP server "${entry.spec.name}" tool "${pinned.name}" failed: ${messageOf(err)}`,
      );
    }
  }

  reload();
  lastTurnView = view;

  return {
    async beginTurn(signal) {
      try {
        reload();
      } catch (err) {
        opts.onWarning(`could not reload MCP configuration: ${messageOf(err)}`);
      }
      await relistConnected(signal);
      const notices = reviewNotices(lastTurnView, view);
      lastTurnView = view;
      const frozen = view;
      return {
        tools: frozen.sorted,
        withdrawn: [...withdrawn.keys()].sort(compareCodeUnit),
        notices,
        call: (toolName, args, callSignal) => callAgainst(frozen, toolName, args, callSignal),
      };
    },
    tools() {
      return view.sorted;
    },
    servers() {
      return [...registry.values()].map((entry) => ({
        spec: entry.spec,
        trusted: entry.catalog !== undefined,
        trustedToolCount: entry.catalog?.tools.length,
        awaitingReview: view.byServer.get(entry.spec.name)?.added ?? [],
        status: clients.status.get(entry.spec.name) ?? { state: "idle" },
      }));
    },
    trust(catalog) {
      opts.store.writeTrust(catalog);
      reload();
      const entry = registry.get(catalog.server);
      if (entry?.catalog === undefined) return;
      // The preview is newer than any list taken before the user trusted these names.
      observe(
        mcpPoolKey(entry.spec),
        ++stamp,
        catalog.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      );
    },
    reload,
    async close(onWarning) {
      await closeMcpClients(clients, onWarning);
    },
  };
}
