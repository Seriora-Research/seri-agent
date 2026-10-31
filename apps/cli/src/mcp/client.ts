// listTools/callTool, not toolsFromDefinitions: @ai-sdk/mcp and ai pin different @ai-sdk/provider-utils copies whose schemaSymbol unique symbols do not unify.
import { createMCPClient, type OAuthClientProvider, UnauthorizedError } from "@ai-sdk/mcp";
import { capToolResult } from "../capToolResult";
import { messageOf } from "../errors";
import { createMcpAuthProvider, McpLoginRequiredError } from "./authProvider";
import { mcpLine } from "./endpoint";
import { serverIdentity } from "./registry";
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
  | { state: "idle" }
  | { state: "connected"; toolCount: number }
  | { state: "needs-auth" }
  | { state: "failed"; message: string };

export type DialFn = (spec: McpServerSpec, signal?: AbortSignal) => Promise<McpClientHandle>;

declare const poolKeyBrand: unique symbol;
type McpPoolKey = string & { readonly [poolKeyBrand]: true };

type McpPoolSlot = {
  readonly server: string;
  readonly handle: Promise<McpClientHandle>;
};

export type McpClients = {
  readonly dial: DialFn;

  readonly handles: Map<McpPoolKey, McpPoolSlot>;
  readonly status: Map<string, McpServerStatus>;
};

function poolKey(spec: Pick<McpServerSpec, "name" | "url" | "headers">): McpPoolKey {
  const identity = serverIdentity({ url: spec.url.wireHref(), headers: spec.headers });
  return `${spec.name}@${identity}` as McpPoolKey;
}

export function flattenContent(result: {
  content?: readonly { type: string; text?: string }[];
  [key: string]: unknown;
}): string {
  if (result.content === undefined) return "";
  return capToolResult(
    result.content
      .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
      .join("\n"),
  );
}

async function dialServer(
  spec: McpServerSpec,
  signal?: AbortSignal,
  authProvider?: OAuthClientProvider,
): Promise<McpClientHandle> {
  const client = await createMCPClient({
    transport: { type: "http", url: spec.url.wireHref(), headers: spec.headers, authProvider },
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

export function createSessionDial(configDir: string): DialFn {
  return (spec, signal) =>
    dialServer(
      spec,
      signal,
      createMcpAuthProvider({ spec, configDir, interaction: { kind: "refuse" } }),
    );
}

export function isAuthRequired(err: unknown): boolean {
  return err instanceof UnauthorizedError || err instanceof McpLoginRequiredError;
}

function dialOnce(
  clients: McpClients,
  spec: McpServerSpec,
  signal?: AbortSignal,
): Promise<McpClientHandle> {
  const key = poolKey(spec);
  const existing = clients.handles.get(key);
  if (existing !== undefined) return existing.handle;

  const promise = clients
    .dial(spec, signal)
    .then(async (handle) => {
      try {
        const tools = await handle.listTools();
        clients.status.set(spec.name, { state: "connected", toolCount: tools.length });
        return handle;
      } catch (err) {
        try {
          await handle.close();
        } catch {}
        throw err;
      }
    })
    .catch((err: unknown) => {
      clients.handles.delete(key);
      if (isAuthRequired(err)) {
        clients.status.set(spec.name, { state: "needs-auth" });
        throw err;
      }
      const line = mcpLine`${err}`;
      clients.status.set(spec.name, { state: "failed", message: line });
      throw new Error(line);
    });

  clients.handles.set(key, { server: spec.name, handle: promise });
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
    if (isAuthRequired(err)) {
      throw new Error(
        `MCP server "${spec.name}" needs authentication. Run /mcp auth ${spec.name}.`,
      );
    }
    throw new Error(mcpLine`MCP server "${spec.name}" is unreachable: ${err}`);
  }
  try {
    return await handle.callTool(remoteTool, args, { signal });
  } catch (err) {
    throw new Error(`MCP server "${spec.name}" tool "${remoteTool}" failed: ${messageOf(err)}`);
  }
}

export async function fetchCatalog(
  spec: McpServerSpec,
  signal?: AbortSignal,
  dial: DialFn = dialServer,
): Promise<McpCatalog> {
  let handle: McpClientHandle | undefined;
  try {
    handle = await dial(spec, signal);
    const tools = await handle.listTools();
    return {
      server: spec.name,
      identity: serverIdentity({ url: spec.url.wireHref(), headers: spec.headers }),
      fetchedAt: new Date().toISOString(),
      tools: tools.map((tool) => ({
        name: tool.name,
        toolName: mcpToolName(spec.name, tool.name),
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
      })),
    };
  } catch (err) {
    if (isAuthRequired(err)) throw err;
    throw new Error(mcpLine`${err}`);
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {}
    }
  }
}

const MCP_CLOSE_TIMEOUT_MS = 5_000;

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

export async function closeMcpClients(
  clients: McpClients,
  onWarning: (message: string) => void,
  timeoutMs = MCP_CLOSE_TIMEOUT_MS,
): Promise<void> {
  const closing = [...clients.handles.values()].map((slot) =>
    closeBounded(
      slot.handle.then((client) => client.close()),
      timeoutMs,
    ).catch((err: unknown) =>
      onWarning(`could not close MCP server "${slot.server}": ${messageOf(err)}`),
    ),
  );
  clients.handles.clear();
  clients.status.clear();
  await Promise.all(closing);
}

export function mcpServerStatus(clients: McpClients, name: string): McpServerStatus {
  return clients.status.get(name) ?? { state: "idle" };
}
