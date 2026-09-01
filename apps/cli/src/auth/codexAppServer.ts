import { type ChildProcess, spawn as spawnReal } from "node:child_process";
import { createInterface } from "node:readline";
import pkg from "../../package.json";
import { killOnFatalSignal } from "../tools/spawnCollect";
import { findCodexBin } from "./codexBin";

export type CodexJsonRpc = {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  close(): void;
};

export type ConnectCodexAppServerOpts = {
  spawn?: typeof spawnReal;
  command?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

const DEFAULT_TIMEOUT_MS = 30_000;

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

export async function connectCodexAppServer(
  opts: ConnectCodexAppServerOpts = {},
): Promise<CodexJsonRpc> {
  const command = opts.command ?? findCodexBin(opts.env ?? process.env);
  if (command === undefined) {
    throw new Error("Codex CLI is not installed.");
  }
  const spawnFn = opts.spawn ?? spawnReal;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const child = spawnFn(command, ["app-server", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: opts.env ?? process.env,
  });
  if (child.stdin === null || child.stdout === null) {
    child.kill();
    throw new Error("codex app-server did not expose stdio");
  }
  child.stdin.on("error", () => {});

  const pending = new Map<number, Pending>();
  let nextId = 1;
  let closed = false;
  const untrack = killOnFatalSignal(() => {
    if (child.pid !== undefined) child.kill("SIGKILL");
  });

  const failAll = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };

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
    const msg = parsed as { id?: unknown; result?: unknown; error?: unknown };
    if (typeof msg.id !== "number") return;
    const waiter = pending.get(msg.id);
    if (waiter === undefined) return;
    pending.delete(msg.id);
    if (msg.error !== undefined) {
      waiter.reject(new Error(formatRpcError(msg.error)));
      return;
    }
    waiter.resolve(msg.result);
  });

  child.once("error", (err) => {
    closed = true;
    untrack();
    failAll(err instanceof Error ? err : new Error(String(err)));
  });
  child.once("exit", (code, signal) => {
    closed = true;
    untrack();
    rl.close();
    failAll(
      new Error(
        signal !== null
          ? `codex app-server exited from ${signal}`
          : `codex app-server exited with code ${code ?? "null"}`,
      ),
    );
  });

  const rpc: CodexJsonRpc = {
    request(method, params) {
      if (closed) return Promise.reject(new Error("codex app-server is closed"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`codex app-server timed out on ${method}`));
        }, timeoutMs);
        pending.set(id, {
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
          pending.delete(id);
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
