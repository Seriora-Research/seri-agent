import { type ChildProcessByStdio, spawn, spawnSync } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { onAbort } from "../abort";
import { onSignalCleanup } from "../signals";

export type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
};

const MAX_OUTPUT_CHARS = 30_000;
const HALF = MAX_OUTPUT_CHARS / 2;

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

// A JS string is UTF-16; a cut between surrogates leaves a lone half that cannot round-trip UTF-8.
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function createBoundedSink() {
  let head = "";
  let tail = "";
  let total = 0;

  return {
    write(chunk: string): void {
      total += chunk.length;

      if (head.length < HALF) {
        const room = HALF - head.length;
        head += chunk.slice(0, room);
        chunk = chunk.slice(room);
      }

      if (chunk) tail = (tail + chunk).slice(-HALF);
    },

    result(): { text: string; truncated: boolean } {
      if (total <= head.length + tail.length) return { text: head + tail, truncated: false };

      const start = isHighSurrogate(head.charCodeAt(head.length - 1)) ? head.slice(0, -1) : head;
      const end = isLowSurrogate(tail.charCodeAt(0)) ? tail.slice(1) : tail;
      const omitted = total - start.length - end.length;
      return { text: `${start}\n... [${omitted} characters omitted] ...\n${end}`, truncated: true };
    },
  };
}

// Windows child.kill() reports success and leaves the shell's process tree running.
function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }

  try {
    // POSIX: a negative pid signals the process group spawned with detached: true.
    process.kill(-pid, "SIGKILL");
  } catch {
  }
}

const inFlightKills = new Set<() => void>();

export function killOnFatalSignal(kill: () => void): () => void {
  inFlightKills.add(kill);
  return () => inFlightKills.delete(kill);
}

function killInFlightChildren(): void {
  for (const kill of inFlightKills) kill();
  inFlightKills.clear();
}

onSignalCleanup(killInFlightChildren);

export function spawnCollect(
  executable: string,
  args: string[],
  timeoutMs?: number,
  signal?: AbortSignal,
  cwd?: string,
  stdin?: string,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    // Windows detached: true opens a new console window.
    const spawnOptions = {
      detached: process.platform !== "win32",
      ...(cwd !== undefined ? { cwd } : {}),
    };
    let child:
      | ChildProcessByStdio<Writable, Readable, Readable>
      | ChildProcessByStdio<null, Readable, Readable>;
    if (stdin !== undefined) {
      child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], ...spawnOptions });
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    } else {
      child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], ...spawnOptions });
    }
    const untrack = killOnFatalSignal(() => {
      if (child.pid !== undefined) killTree(child.pid);
    });

    const out = createBoundedSink();
    const err = createBoundedSink();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => out.write(chunk));
    child.stderr.on("data", (chunk: string) => err.write(chunk));

    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        if (child.pid !== undefined) killTree(child.pid);
      },
      Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    );

    const abort = onAbort(signal, () => {
      if (child.pid !== undefined) killTree(child.pid);
    });

    const settled = (): void => {
      clearTimeout(timer);
      abort.dispose();
      untrack();
    };

    child.on("error", (error) => {
      settled();
      reject(error);
    });

    child.on("close", (code) => {
      settled();
      if (abort.aborted()) {
        reject(new Error("cancelled"));
        return;
      }
      const stdout = out.result();
      const stderr = err.result();
      resolve({
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode: code ?? 1,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
      });
    });
  });
}
