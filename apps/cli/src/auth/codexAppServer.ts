import { type ChildProcess, type SpawnOptions, spawn as spawnReal } from "node:child_process";
import { createInterface } from "node:readline";
import pkg from "../../package.json";
import { killOnFatalSignal } from "../tools/spawnCollect";
import { findCodexBin, resolveCodexSpawn } from "./codexBin";

export type CodexJsonRpc = {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  close(): void;
};

export type CodexSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type ConnectCodexAppServerOpts = {
  spawn?: CodexSpawn;
  command?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const STDERR_TAIL_CHARS = 400;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

function writeLine(child: ChildProcess, payload: unknown): void {
  if (child.stdin === null || child.killed) {
    throw new Error("codex app-server stdin is closed");
  }
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function rpcIdKey(id: unknown): string | undefined {
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  if (typeof id === "string" && id.length > 0) return id;
  return undefined;
}

function withStderrTail(base: string, tail: string): string {
  const extra = tail.trim().replace(/\s+/g, " ");
  return extra.length === 0 ? base : `${base}: ${extra.slice(-STDERR_TAIL_CHARS)}`;
}

export async function connectCodexAppServer(
  opts: ConnectCodexAppServerOpts = {},
): Promise<CodexJsonRpc> {
  const command = opts.command ?? findCodexBin(opts.env ?? process.env);
  if (command === undefined) {
    throw new Error("Codex CLI is not installed.");
  }
  const spawnFn: CodexSpawn = opts.spawn ?? spawnReal;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const launched = resolveCodexSpawn(command, ["app-server", "--stdio"]);
  let child: ChildProcess;
  try {
    child = spawnFn(launched.command, launched.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env ?? process.env,
      windowsHide: true,
      ...(launched.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
  const pending = new Map<string, Pending>();
  let nextId = 1;
  let closed = false;
  let untrack = (): void => {};

  const failAll = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };

  child.once("error", (err) => {
    closed = true;
    untrack();
    failAll(err instanceof Error ? err : new Error(String(err)));
  });

  if (child.stdin === null || child.stdout === null) {
    child.kill();
    throw new Error("codex app-server did not expose stdio");
  }
  child.stdin.on("error", () => {});




  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
  });

  untrack = killOnFatalSignal(() => {
    if (child.pid !== undefined) child.kill("SIGKILL");
  });

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (line.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const msg = parsed as Record<string, unknown>;
    if (!("result" in msg || "error" in msg)) return;
    const key = rpcIdKey(msg.id);
    if (key === undefined) return;
    const waiter = pending.get(key);
    if (waiter === undefined) return;
    pending.delete(key);
    if (msg.error !== undefined) {
      waiter.reject(new Error(formatRpcError(msg.error)));
      return;
    }
    waiter.resolve(msg.result);
  });

  child.once("exit", (code, signal) => {
    closed = true;
    untrack();
    rl.close();
    failAll(
      new Error(
        withStderrTail(
          signal !== null
            ? `codex app-server exited from ${signal}`
            : `codex app-server exited with code ${code ?? "null"}`,
          stderrTail,
        ),
      ),
    );
  });

  const rpc: CodexJsonRpc = {
    request(method, params) {
      if (closed) return Promise.reject(new Error("codex app-server is closed"));
      const id = nextId++;
      const key = String(id);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(new Error(withStderrTail(`codex app-server timed out on ${method}`, stderrTail)));
        }, timeoutMs);
        pending.set(key, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        try {
          writeLine(child, params === undefined ? { id, method } : { id, method, params });
        } catch (err) {
          pending.delete(key);
          clearTimeout(timer);
          reject(err);
        }
      });
    },
    notify(method, params) {
      writeLine(child, params === undefined ? { method } : { method, params });
    },
    close() {
      if (closed) return;
      closed = true;
      untrack();
      rl.close();
      failAll(new Error("codex app-server closed"));
      if (child.pid !== undefined) child.kill("SIGKILL");
    },
  };

  try {
    await rpc.request("initialize", {
      clientInfo: { name: "seri", title: "seri", version: pkg.version },
    });
    rpc.notify("initialized");
  } catch (err) {
    rpc.close();
    throw err;
  }
  return rpc;
}

function formatRpcError(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return `codex app-server error: ${JSON.stringify(error)}`;
}
