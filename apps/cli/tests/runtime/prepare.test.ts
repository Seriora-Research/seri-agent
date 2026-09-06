import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCatalogCache } from "@seri/model-catalog";
import type { ToolExecutionOptions } from "ai";
import { loadAgentsFile } from "../../src/agents/loadAgentsFile";
import type { RunContext } from "../../src/cli";
import { inspectConfig, loadVerifyConfig } from "../../src/config/config";
import { denialBlocks } from "../../src/gate/gate";
import type { HooksLoad } from "../../src/hooks/registry";
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
  createSessionTrajectory,
  gatewayNotice,
  loadOrCreateSession,
  type PreparedRun,
  prepareSession,
} from "../../src/runtime/prepare";
import { SessionDatabase } from "../../src/session/database";
import { expectDedicatedFileTools, expectNoBashFirstSteer } from "../agents/bashFirstSteer";

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
      () => ({ skills: new Map(), rules: new Map(), hooks: { registry: new Map() } }),
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
    loadExtensions: () => ({ skills: new Map(), rules: new Map(), hooks: { registry: new Map() } }),
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

  test("skipPermissions seeds the outside-cwd latch for this run only", async () => {
    const attended = (await prepareSession(baseCtx(makeDir()), deps, false, false)) as PreparedRun;
    expect(attended.outsideConsent?.current).toBe("unasked");
    const skipped = (await prepareSession(baseCtx(makeDir()), deps, true, false)) as PreparedRun;
    expect(skipped.outsideConsent?.current).toBe("allowed-this-run");
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

  test("skip-permissions does not change the assembled system prompt or invert dedicated file tools", async () => {
    const attended = await prepareSession(baseCtx(makeDir()), deps, false, false);
    const bypass = await prepareSession(baseCtx(makeDir()), deps, true, false);
    expect(typeof attended).not.toBe("number");
    expect(typeof bypass).not.toBe("number");
    const attendedRun = attended as PreparedRun;
    const bypassRun = bypass as PreparedRun;
    expect(attendedRun.session.systemPrompt).toBe(bypassRun.session.systemPrompt);
    expect(attendedRun.permissionMode).not.toBe("auto");
    expect(bypassRun.permissionMode).toBe("auto");
    expectDedicatedFileTools(attendedRun.session.systemPrompt);
    expectNoBashFirstSteer(attendedRun.session.systemPrompt);
  });

  test("prepareSession loads path denials from permissions.yaml", async () => {
    mkdirSync(permissionsDir, { recursive: true });
    writeFileSync(
      permissionsPath(permissionsDir),
      "global: []\nprojects: {}\ndeny:\n  - glob(/secret/**)\n  - read_file(.env)\n",
    );
    const result = await prepareSession(baseCtx(makeDir()), deps, false, false);
    expect(typeof result).not.toBe("number");
    expect((result as PreparedRun).pathDenials).toEqual([
      { tool: "glob", pattern: "/secret/**" },
      { tool: "read_file", pattern: ".env" },
    ]);
  });

  test("an unreadable config.json does not drop path denials or PreToolUse hooks", async () => {
    mkdirSync(permissionsDir, { recursive: true });
    writeFileSync(
      permissionsPath(permissionsDir),
      "global: []\nprojects: {}\ndeny:\n  - read_file(.env)\n  - path: /tmp/secret\n  - 42\n",
    );
    const seriDir = mcpConfigDirFor(tmpConfigRoot);
    mkdirSync(seriDir, { recursive: true });
    writeFileSync(join(seriDir, "config.json"), "{nope");
    expect(inspectConfig(seriDir).status).toBe("malformed");

    const hooksDir = join(seriDir, "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, "hooks.yaml"),
      "hooks:\n  PreToolUse:\n    - script: block-dangerous\n",
    );
    writeFileSync(join(hooksDir, "block-dangerous.sh"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(hooksDir, "block-dangerous.ps1"), "exit 0\n");

    const cwd = makeDir();
    const result = await prepareSession(baseCtx(cwd), { loadAgentsFile: () => "" }, false, true);
    expect(typeof result).not.toBe("number");
    const prepared = result as PreparedRun;
    expect(prepared.pathDenials).toEqual([{ tool: "read_file", pattern: ".env" }]);
    expect(prepared.hooks.registry.get("PreToolUse")?.map((spec) => spec.script)).toEqual([
      "block-dangerous",
    ]);
    expect(
      prepared.preMountMessages.some(
        (message) => message.text.includes("deny[1]") && message.text.includes("object"),
      ),
    ).toBe(true);
    expect(
      prepared.preMountMessages.some(
        (message) => message.text.includes("deny[2]") && message.text.includes("number"),
      ),
    ).toBe(true);
    expect(denialBlocks(prepared.pathDenials, "read_file", { path: join(cwd, ".env") }, cwd)).toBe(
      true,
    );
  });

  test("permissions.yaml ask loads onto PreparedRun with the allow-all classifier", async () => {
    mkdirSync(permissionsDir, { recursive: true });
    writeFileSync(
      permissionsPath(permissionsDir),
      "global: []\nprojects: {}\nautoModeOnBlock: ask\n",
    );
    const result = await prepareSession(baseCtx(makeDir()), deps, false, true);
    const prepared = result as PreparedRun;
    expect(prepared.autoModeOnBlock).toBe("ask");
    expect(prepared.classifyToolCall).toBeDefined();
    expect(prepared.classifyToolCall?.("bash", { command: "git push origin v0.42.0" })).toEqual({
      kind: "allow",
    });
  });

  test("a missing permissions.yaml is deny and still installs the classifier", async () => {
    const result = await prepareSession(baseCtx(makeDir()), deps, false, false);
    const prepared = result as PreparedRun;
    expect(prepared.autoModeOnBlock).toBe("deny");
    expect(prepared.classifyToolCall).toBeDefined();
  });

  test("a non-TTY run is deny even when YAML says ask", async () => {
    mkdirSync(permissionsDir, { recursive: true });
    writeFileSync(
      permissionsPath(permissionsDir),
      "global: []\nprojects: {}\nautoModeOnBlock: ask\n",
    );
    const result = await prepareSession(baseCtx(makeDir()), deps, false, false);
    const prepared = result as PreparedRun;
    expect(prepared.autoModeOnBlock).toBe("deny");
    expect(prepared.classifyToolCall).toBeDefined();
  });

  test("skipPermissions omits the classifier so a YAML ask cannot fire", async () => {
    mkdirSync(permissionsDir, { recursive: true });
    writeFileSync(
      permissionsPath(permissionsDir),
      "global: []\nprojects: {}\nautoModeOnBlock: ask\n",
    );
    const result = await prepareSession(baseCtx(makeDir()), deps, true, true);
    const prepared = result as PreparedRun;
    expect(prepared.permissionMode).toBe("auto");
    expect(prepared.autoModeOnBlock).toBe("ask");
    expect(prepared.classifyToolCall).toBeUndefined();
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
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
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
    // Named, not counted. `process.env.HOME` above points at a temp root, but the worktree this
    // session starts in is a mkdtemp directory, and on Windows that sits UNDER the real profile —
    // so findProjectExtensionDir's upward walk still reaches the developer's own `~/.seri/mcp` and
    // claims it as project scope, which the guard there cannot recognise once HOME has moved off
    // it. A size assertion turns "this machine has an MCP server configured" into a failure of a
    // test about bindSession; the name this test seeds is what it actually cares about.
    expect(prepared.mcp.has("exa")).toBe(false);

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

  test("bindSession reloads path denials from disk", async () => {
    const prepared = await freshPrepared();
    expect(prepared.pathDenials).toEqual([]);
    mkdirSync(permissionsDir, { recursive: true });
    writeFileSync(
      permissionsPath(permissionsDir),
      "global: []\nprojects: {}\ndeny:\n  - grep(/hidden/**)\n",
    );
    bindSession(
      prepared,
      { ...prepared.session, id: "next" },
      mcpConfigDirFor(tmpConfigRoot),
      permissionsDir,
      () => {},
    );
    expect(prepared.pathDenials).toEqual([{ tool: "grep", pattern: "/hidden/**" }]);
  });

  test("bindSession reloads autoModeOnBlock from disk", async () => {
    const prepared = await freshPrepared();
    expect(prepared.autoModeOnBlock).toBe("deny");
    mkdirSync(permissionsDir, { recursive: true });
    writeFileSync(
      permissionsPath(permissionsDir),
      "global: []\nprojects: {}\nautoModeOnBlock: ask\n",
    );
    bindSession(
      prepared,
      { ...prepared.session, id: "next" },
      mcpConfigDirFor(tmpConfigRoot),
      permissionsDir,
      () => {},
    );
    expect(prepared.autoModeOnBlock).toBe("ask");
  });

  // Asserted through preMountMessages rather than a captured console.error, because that queue IS
  // the delivery: prepareSession runs after the shared renderer exists but before the TUI's first
  // frame, so a line written straight to the console in that window is painted over and gone.
  // `isTTY: true` is what selects that path.
  async function hookNoticesFor(hooks: HooksLoad): Promise<string[]> {
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
        loadExtensions: () => ({ skills: new Map(), rules: new Map(), hooks }),
      },
      false,
      true,
    );
    return (result as PreparedRun).preMountMessages
      .map((message) => message.text)
      .filter((text) => text.includes("project hooks in"));
  }

  test("a hooks directory that is present and not running is announced exactly once", async () => {
    expect(
      await hookNoticesFor({
        registry: new Map(),
        untrusted: { dir: "/p/.seri/hooks", verdict: { kind: "untrusted" }, scriptCount: 4 },
      }),
    ).toEqual([
      "⚠ project hooks in /p/.seri/hooks (4 files) have not been reviewed, so none of them ran — /hooks to read them and turn them on",
    ]);

    // The negative control for both of the above: with no `untrusted` field there is no line at
    // all, so neither assertion can be passing on a notice that fires unconditionally.
    expect(await hookNoticesFor({ registry: new Map() })).toEqual([]);
  });

  test("the changed notice names a few files and counts the rest", async () => {
    const files = ["guard.sh", "guard.ps1", "hooks.yaml", "fmt.sh", "fmt.ps1"];
    expect(
      await hookNoticesFor({
        registry: new Map(),
        untrusted: { dir: "/p/.seri/hooks", verdict: { kind: "changed", files }, scriptCount: 4 },
      }),
    ).toEqual([
      "⚠ project hooks in /p/.seri/hooks changed since you trusted them (guard.sh, guard.ps1, hooks.yaml and 2 more), so none of them ran — /hooks to review what moved",
    ]);

    // A directory small enough to name whole gets no trailing count — the cap is a guard against
    // an unreadable line, not a format every message pays for.
    expect(
      await hookNoticesFor({
        registry: new Map(),
        untrusted: {
          dir: "/p/.seri/hooks",
          verdict: { kind: "changed", files: ["guard.sh", "guard.ps1"] },
          scriptCount: 2,
        },
      }),
    ).toEqual([
      "⚠ project hooks in /p/.seri/hooks changed since you trusted them (guard.sh, guard.ps1), so none of them ran — /hooks to review what moved",
    ]);
  });
});

describe("createSessionTrajectory held database", () => {
  test("reuses a database whose configDir is the trajectory store", () => {
    const configDir = makeDir();
    const database = new SessionDatabase(configDir);
    const originalClose = SessionDatabase.prototype.close;
    let closes = 0;
    SessionDatabase.prototype.close = function (this: SessionDatabase) {
      closes++;
      return originalClose.call(this);
    };
    try {
      const writer = createSessionTrajectory(
        { id: "sess", cwd: "/repo" },
        configDir,
        () => {},
        database,
      );
      writer.recordLoopEvent({ type: "done", reason: "no-tool-call" });
      expect(closes).toBe(0);
    } finally {
      SessionDatabase.prototype.close = originalClose;
      database.close();
    }
  });

  test("does not reuse a database whose configDir is a different store", () => {
    const sessionStore = makeDir();
    const configDir = makeDir();
    const database = new SessionDatabase(sessionStore);
    const originalClose = SessionDatabase.prototype.close;
    let closes = 0;
    SessionDatabase.prototype.close = function (this: SessionDatabase) {
      closes++;
      return originalClose.call(this);
    };
    try {
      const writer = createSessionTrajectory(
        { id: "sess", cwd: "/repo" },
        configDir,
        () => {},
        database,
      );
      writer.recordLoopEvent({ type: "done", reason: "no-tool-call" });
      expect(closes).toBeGreaterThan(0);
    } finally {
      SessionDatabase.prototype.close = originalClose;
      database.close();
    }
  });
});

describe("gatewayNotice", () => {
  const route = {
    model: "openai/gpt-oss-120b",
    provider: "openrouter" as const,
    rerouted: false,
    credential: "gateway" as const,
  };

  test("names the seri plan, not OpenRouter, when no provider was requested", () => {
    expect(gatewayNotice(route, undefined)).toBe("routing openai/gpt-oss-120b on your seri plan");
  });

  test("does not blame a missing OpenRouter key when the plan is serving that catalog row", () => {
    expect(gatewayNotice(route, "openrouter")).toBe(
      "routing openai/gpt-oss-120b on your seri plan",
    );
  });

  test("blames a different requested provider that had no key", () => {
    expect(gatewayNotice(route, "groq")).toBe(
      "routing openai/gpt-oss-120b on your seri plan — no Groq key configured",
    );
  });
});
