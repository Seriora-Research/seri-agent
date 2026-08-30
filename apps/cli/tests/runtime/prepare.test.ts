import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCatalogCache } from "@seri/model-catalog";
import type { ToolExecutionOptions } from "ai";
import { loadAgentsFile } from "../../src/agents/loadAgentsFile";
import type { RunContext } from "../../src/cli";
import { loadVerifyConfig } from "../../src/config/config";
import {
  callMcpTool,
  createMcpClients,
  type DialFn,
  type McpClientHandle,
} from "../../src/mcp/client";
import { toolFingerprint, writeCatalogCache } from "../../src/mcp/registry";
import { type McpToolInfo, mcpGrantKey } from "../../src/mcp/types";
import { permissionsPath } from "../../src/permissions/store";
import {
  bindSession,
  buildCheckpointedTools,
  loadOrCreateSession,
  type PreparedRun,
  prepareSession,
} from "../../src/runtime/prepare";

const execOpts: ToolExecutionOptions<Record<string, unknown>> = {
  toolCallId: "test-call",
  messages: [],
  context: {},
};

let dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seri-prepare-cwd-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("explicit session cwd", () => {
  test("a new session records the injected cwd, not process.cwd()", () => {
    const sessionDir = makeDir();
    const configDir = makeDir();
    const original = process.cwd();
    const { session } = loadOrCreateSession(
      false,
      undefined,
      join(configDir, "sessions"),
      loadAgentsFile,
      configDir,
      sessionDir,
      () => ({ skills: new Map(), rules: new Map() }),
    );
    expect(session.cwd).toBe(sessionDir);
    expect(session.cwd).not.toBe(original);
    expect(process.cwd()).toBe(original);
  });

  test("checkpointed tools read relative paths from the session cwd", async () => {
    const sessionDir = makeDir();
    const storeDir = makeDir();
    writeFileSync(join(sessionDir, "note.txt"), "from-session");
    const { tools } = buildCheckpointedTools({
      storeDir,
      worktree: sessionDir,
      sessionId: "sess",
      cwd: sessionDir,
      verifyConfig: loadVerifyConfig(sessionDir),
      onWarning: () => {},
    });
    const original = process.cwd();
    const contents = await tools.read_file.execute?.({ path: "note.txt" }, execOpts);
    expect(contents).toBe("from-session");
    expect(process.cwd()).toBe(original);
  });
});

// getConfigDir()'s own resolution (config/paths.ts): join(process.env.HOME, ".seri") under the
// default profile, which is what every test below actually reads/writes MCP config through — none
// of these override CliDeps.authConfigDir, so this must match prepareSession's own internal
// resolution exactly or every fixture below would be writing beside the file it is meant to seed.
function mcpConfigDirFor(tmpConfigRoot: string): string {
  return join(tmpConfigRoot, ".seri");
}

describe("prepareSession + mcp", () => {
  const originalKey = process.env.GROQ_API_KEY;
  const originalHome = process.env.HOME;
  const originalDisableModelsFetch = process.env.SERI_DISABLE_MODELS_FETCH;
  let tmpConfigRoot: string;
  let sessionsDir: string;
  let permissionsDir: string;

  function restoreEnv(key: string, original: string | undefined): void {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }

  function writeGlobalServer(name: string, url: string): void {
    const dir = join(mcpConfigDirFor(tmpConfigRoot), "mcp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "servers.yaml"), `servers:\n  ${name}:\n    url: ${url}\n`);
  }

  function writeGlobalGrant(entry: string): void {
    mkdirSync(permissionsDir, { recursive: true });
    writeFileSync(permissionsPath(permissionsDir), `global:\n  - ${entry}\nprojects: {}\n`);
  }

  function baseCtx(cwd: string): RunContext {
    return {
      resuming: false,
      resumeId: undefined,
      taskText: "hi",
      sessionsDir,
      checkpointsDir: join(tmpConfigRoot, "checkpoints"),
      permissionsDir,
      configDir: tmpConfigRoot,
      cwd,
    };
  }

  const deps = {
    loadAgentsFile: () => "",
    loadExtensions: () => ({ skills: new Map(), rules: new Map() }),
  };

  // Same fixture-isolation shape cli.test.ts's own "run" describes use: a fresh HOME per test so a
  // real ~/.seri on the machine running this suite can never supply a server this test did not
  // configure, and SERI_DISABLE_MODELS_FETCH plus a cache reset so the model catalog fetch every
  // prepareSession call makes stays the deterministic bundled fallback.
  beforeEach(() => {
    process.env.GROQ_API_KEY = "fake-test-key";
    tmpConfigRoot = makeDir();
    sessionsDir = join(tmpConfigRoot, "sessions");
    permissionsDir = join(tmpConfigRoot, "permissions");
    process.env.HOME = tmpConfigRoot;
    resetCatalogCache();
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
  });

  afterEach(() => {
    restoreEnv("GROQ_API_KEY", originalKey);
    restoreEnv("HOME", originalHome);
    restoreEnv("SERI_DISABLE_MODELS_FETCH", originalDisableModelsFetch);
    resetCatalogCache();
  });

  // The spec's own verify line for this unit: session start performs no network I/O even with a
  // server configured. mcp/registry.test.ts already asserts this at loadMcpRegistry's own module
  // boundary; this asserts it through the actual call site session start makes, end to end.
  test("session start performs no network I/O with an MCP server configured", async () => {
    writeGlobalServer("ghost", "https://127.0.0.1:1/mcp");
    const result = await prepareSession(baseCtx(makeDir()), deps, false, false);
    expect(typeof result).not.toBe("number");
    const prepared = result as PreparedRun;
    const entry = prepared.mcp.get("ghost");
    expect(entry).toBeDefined();
    expect(entry?.catalog).toBeUndefined();
  });

  test("a stored MCP grant whose digest matches the session catalog enters allowedTools as the bare name", async () => {
    writeGlobalServer("exa", "https://mcp.exa.ai/mcp");
    const tool: McpToolInfo = {
      name: "web_search",
      toolName: "mcp_exa_web_search",
      description: "Search the web.",
      inputSchema: { type: "object" },
    };
    writeCatalogCache(mcpConfigDirFor(tmpConfigRoot), {
      server: "exa",
      fetchedAt: new Date().toISOString(),
      tools: [tool],
    });
    writeGlobalGrant(mcpGrantKey(tool.toolName, toolFingerprint(tool)));

    const result = await prepareSession(baseCtx(makeDir()), deps, false, false);
    const prepared = result as PreparedRun;
    expect(prepared.allowedTools).toContain("mcp_exa_web_search");
    // The bare name only — the stored entry's own "@<digest>" suffix must not leak into the set
    // the gate actually compares call subjects against.
    expect(prepared.allowedTools.some((entry) => entry.includes("@"))).toBe(false);
  });

  // Seen red first: with filterMcpGrants' own fingerprint check deleted (kept unconditionally
  // instead), this assertion fails — allowedTools contains "mcp_exa_web_search" even though the
  // catalog on disk no longer matches what the grant was approved against.
  test("a stored MCP grant whose digest no longer matches is dropped and warns", async () => {
    writeGlobalServer("exa", "https://mcp.exa.ai/mcp");
    const approvedTool: McpToolInfo = {
      name: "web_search",
      toolName: "mcp_exa_web_search",
      description: "Search the web.",
      inputSchema: { type: "object" },
    };
    writeGlobalGrant(mcpGrantKey(approvedTool.toolName, toolFingerprint(approvedTool)));

    // The catalog now on disk is not what the grant was approved against — the rug-pull case.
    const changedTool: McpToolInfo = {
      ...approvedTool,
      description: "Search the web, differently.",
    };
    writeCatalogCache(mcpConfigDirFor(tmpConfigRoot), {
      server: "exa",
      fetchedAt: new Date().toISOString(),
      tools: [changedTool],
    });

    const result = await prepareSession(baseCtx(makeDir()), deps, false, true);
    const prepared = result as PreparedRun;
    expect(prepared.allowedTools).not.toContain("mcp_exa_web_search");
    expect(
      prepared.preMountMessages.some(
        (m) => m.text.includes("mcp_exa_web_search") && m.text.includes("asked again"),
      ),
    ).toBe(true);
  });
});

describe("bindSession + mcp", () => {
  const originalKey = process.env.GROQ_API_KEY;
  const originalHome = process.env.HOME;
  const originalDisableModelsFetch = process.env.SERI_DISABLE_MODELS_FETCH;
  let tmpConfigRoot: string;
  let sessionsDir: string;
  let permissionsDir: string;

  function restoreEnv(key: string, original: string | undefined): void {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }

  beforeEach(() => {
    process.env.GROQ_API_KEY = "fake-test-key";
    tmpConfigRoot = makeDir();
    sessionsDir = join(tmpConfigRoot, "sessions");
    permissionsDir = join(tmpConfigRoot, "permissions");
    process.env.HOME = tmpConfigRoot;
    resetCatalogCache();
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
  });

  afterEach(() => {
    restoreEnv("GROQ_API_KEY", originalKey);
    restoreEnv("HOME", originalHome);
    restoreEnv("SERI_DISABLE_MODELS_FETCH", originalDisableModelsFetch);
    resetCatalogCache();
  });

  async function freshPrepared(): Promise<PreparedRun> {
    const ctx: RunContext = {
      resuming: false,
      resumeId: undefined,
      taskText: "hi",
      sessionsDir,
      checkpointsDir: join(tmpConfigRoot, "checkpoints"),
      permissionsDir,
      configDir: tmpConfigRoot,
      cwd: makeDir(),
    };
    const result = await prepareSession(
      ctx,
      {
        loadAgentsFile: () => "",
        loadExtensions: () => ({ skills: new Map(), rules: new Map() }),
      },
      false,
      false,
    );
    return result as PreparedRun;
  }

  // Seen red first: with the closeMcpClients call deleted from bindSession, closeCalls stays 0 —
  // the dialled handle is dropped on the floor instead of closed, which is the one-leaked-socket-
  // per-/clear failure this test exists to catch.
  test("bindSession closes the previous mcp clients before installing a fresh pool", async () => {
    const prepared = await freshPrepared();
    let closeCalls = 0;
    const dial: DialFn = async () => {
      const handle: McpClientHandle = {
        listTools: async () => [],
        callTool: async () => "",
        close: async () => {
          closeCalls++;
        },
      };
      return handle;
    };
    const warmClients = createMcpClients(dial);
    await callMcpTool(
      warmClients,
      {
        name: "ghost",
        url: "https://127.0.0.1:1/mcp",
        headers: {},
        source: "project",
        filePath: "x",
      },
      "noop",
      {},
    );
    prepared.mcpClients = warmClients;

    bindSession(
      prepared,
      { ...prepared.session, id: "next" },
      mcpConfigDirFor(tmpConfigRoot),
      permissionsDir,
      () => {},
    );
    // closeMcpClients' own close call is fire-and-forget, chained through two .then/.catch hops on
    // an already-resolved promise (mcp/client.ts's own comment) — a macrotask tick is what
    // reliably lets it settle before this asserts.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(closeCalls).toBe(1);
    expect(prepared.mcpClients).not.toBe(warmClients);
    expect(prepared.mcpClients.handles.size).toBe(0);
  });

  test("bindSession reloads the registry and re-derives allowedTools from the persisted grants on disk", async () => {
    const prepared = await freshPrepared();
    expect(prepared.mcp.size).toBe(0);

    // Everything below is written AFTER the session already started — the exact `/mcp reconnect`
    // window bindSession's own re-derivation exists to close.
    const configDir = mcpConfigDirFor(tmpConfigRoot);
    mkdirSync(join(configDir, "mcp"), { recursive: true });
    writeFileSync(
      join(configDir, "mcp", "servers.yaml"),
      "servers:\n  exa:\n    url: https://mcp.exa.ai/mcp\n",
    );
    const tool: McpToolInfo = {
      name: "web_search",
      toolName: "mcp_exa_web_search",
      description: "Search the web.",
      inputSchema: {},
    };
    writeCatalogCache(configDir, {
      server: "exa",
      fetchedAt: new Date().toISOString(),
      tools: [tool],
    });
    mkdirSync(permissionsDir, { recursive: true });
    writeFileSync(
      permissionsPath(permissionsDir),
      `global:\n  - ${mcpGrantKey(tool.toolName, toolFingerprint(tool))}\nprojects: {}\n`,
    );

    bindSession(prepared, { ...prepared.session, id: "next" }, configDir, permissionsDir, () => {});

    expect(prepared.mcp.get("exa")).toBeDefined();
    expect(prepared.allowedTools).toContain("mcp_exa_web_search");
  });
});
