// The only file in the feature that touches the network. Consumes exactly two calls from
// @ai-sdk/mcp: listTools() and callTool(). toolsFromDefinitions() looks like the obvious
// shortcut — it turns a catalog straight into an AI SDK ToolSet — but its return type does not
// assign to seri's ToolSet: @ai-sdk/mcp pins @ai-sdk/provider-utils 5.0.33 while ai@7.0.58
// resolves 5.0.25 (and 5.0.18), and each copy declares its own `unique symbol` schemaSymbol, so
// the branded Schema types are nominally distinct ("Property '[schemaSymbol]' is missing in type
// 'Schema<unknown>' but required in type 'Schema<never>'"). listTools and callTool take and
// return plain JSON, so nothing branded crosses this boundary and no version pin is needed to
// keep this typechecking clean. Do not "simplify" this back to toolsFromDefinitions().
import { createMCPClient, UnauthorizedError } from "@ai-sdk/mcp";
import { messageOf } from "../errors";
import type { McpCatalog, McpServerSpec } from "./types";
import { mcpToolName } from "./types";

export type McpClientHandle = {
  listTools(): Promise<readonly { name: string; description?: string; inputSchema: unknown }[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal },
  ): Promise<string>;
  close(): Promise<void>;
};

export type McpServerStatus =
  | { state: "idle" } // configured, never dialled
  | { state: "connected"; toolCount: number }
  | { state: "needs-auth" }
  | { state: "failed"; message: string };

export type DialFn = (spec: McpServerSpec, signal?: AbortSignal) => Promise<McpClientHandle>;

export type McpClients = {
  // The pool's own dial function rather than a session-level default kept elsewhere: a pool is
  // complete on its own terms, and a test pool is constructible with no second mechanism (a
  // registry, a WeakMap) to wire up alongside it.
  readonly dial: DialFn;
  // Promise-keyed so two calls racing the first dial share one connection rather than opening
  // two, and a rejected dial is evicted (see dialOnce) so the next call retries instead of the
  // server staying broken for the session.
  readonly handles: Map<string, Promise<McpClientHandle>>;
  readonly status: Map<string, McpServerStatus>;
};

// A non-text part is rendered by type rather than dropped: a caller reading only the joined
// string would otherwise lose an image or resource result and never learn the tool returned one
// at all.
export function flattenContent(result: {
  content?: readonly { type: string; text?: string }[];
  [key: string]: unknown;
}): string {
  if (result.content === undefined) return "";
  return result.content
    .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
    .join("\n");
}

async function dialServer(spec: McpServerSpec, signal?: AbortSignal): Promise<McpClientHandle> {
  const client = await createMCPClient({
    transport: { type: "http", url: spec.url, headers: spec.headers },
    clientName: "seri",
    initializationOptions: { signal },
  });
  return {
    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    },
    async callTool(name, args, opts) {
      const result = await client.callTool({
        name,
        arguments: args,
        options: { signal: opts.signal },
      });
      return flattenContent(result);
    },
    close: () => client.close(),
  };
}

export function createMcpClients(dial: DialFn = dialServer): McpClients {
  return { dial, handles: new Map(), status: new Map() };
}

function dialOnce(
  clients: McpClients,
  spec: McpServerSpec,
  signal?: AbortSignal,
): Promise<McpClientHandle> {
  const existing = clients.handles.get(spec.name);
  if (existing !== undefined) return existing;

  const promise = clients
    .dial(spec, signal)
    .then(async (handle) => {
      const tools = await handle.listTools();
      clients.status.set(spec.name, { state: "connected", toolCount: tools.length });
      return handle;
    })
    .catch((err: unknown) => {
      // A rejected promise never becomes a resolved one, so a poisoned entry left in the map
      // would fail every call for the rest of the session. Evicting it here is what makes the
      // next call try again instead.
      clients.handles.delete(spec.name);
      clients.status.set(
        spec.name,
        err instanceof UnauthorizedError
          ? { state: "needs-auth" }
          : { state: "failed", message: messageOf(err) },
      );
      throw err;
    });

  clients.handles.set(spec.name, promise);
  return promise;
}

export async function callMcpTool(
  clients: McpClients,
  spec: McpServerSpec,
  remoteTool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  let handle: McpClientHandle;
  try {
    handle = await dialOnce(clients, spec, signal);
  } catch (err) {
    throw new Error(`MCP server "${spec.name}" is unreachable: ${messageOf(err)}`);
  }
  try {
    return await handle.callTool(remoteTool, args, { signal });
  } catch (err) {
    throw new Error(`MCP server "${spec.name}" tool "${remoteTool}" failed: ${messageOf(err)}`);
  }
}

// Its own connection, dialled and closed here rather than through the session pool: this is the
// `/mcp add` preview path, and a server nobody has trusted yet has no business entering the pool
// that every later tool call reuses.
export async function fetchCatalog(
  spec: McpServerSpec,
  signal?: AbortSignal,
  dial: DialFn = dialServer,
): Promise<McpCatalog> {
  const handle = await dial(spec, signal);
  try {
    const tools = await handle.listTools();
    return {
      server: spec.name,
      fetchedAt: new Date().toISOString(),
      tools: tools.map((tool) => ({
        name: tool.name,
        toolName: mcpToolName(spec.name, tool.name),
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
      })),
    };
  } finally {
    // Best-effort: whatever the preview connection's close does or doesn't do, it must not mask
    // whichever of the two awaits above actually failed.
    try {
      await handle.close();
    } catch {}
  }
}

// Synchronous and fire-and-forget internally: bindSession (runtime/prepare.ts) is synchronous,
// and a third-party server that hangs its own close must not stall /clear. Failures are reported
// through onWarning, never thrown. Idempotent: clearing both maps leaves a second call with
// nothing to close.
export function closeMcpClients(clients: McpClients, onWarning: (message: string) => void): void {
  for (const [name, handle] of clients.handles) {
    handle
      .then((client) => client.close())
      .catch((err: unknown) =>
        onWarning(`could not close MCP server "${name}": ${messageOf(err)}`),
      );
  }
  clients.handles.clear();
  clients.status.clear();
}

export function mcpServerStatus(clients: McpClients, name: string): McpServerStatus {
  return clients.status.get(name) ?? { state: "idle" };
}
