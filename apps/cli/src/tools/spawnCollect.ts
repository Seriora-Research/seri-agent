import { spawn, spawnSync } from "node:child_process";

// Truncation is reported per stream rather than as one flag. A single OR'd boolean cannot say
// which stream was cut, so a command that floods stderr while returning a complete stdout
// reads identically to one whose stdout was chopped — and the model re-runs work it already
// had, or trusts output it should not have.
export type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
};

// Both streams were accumulated into unbounded strings, so a runaway command (`yes`, a `cat`
// of a large file, a build log) grew the process until it died and, short of that, handed the
// model an output no context window could hold. Claude Code caps command output at the same
// 30k characters for the same two reasons.
const MAX_OUTPUT_CHARS = 30_000;
const HALF = MAX_OUTPUT_CHARS / 2;

// A command with no ceiling on its runtime blocks the agent forever - a wedged install, a
// server that never exits, a network call with no timeout of its own. Claude Code's shell
// defaults to 2 minutes and allows up to 10, and those numbers hold up here: this repo's
// heaviest commands are `build:all` at 1.3s and the full test suite at 3.9s.
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

// A JS string is UTF-16, so a character outside the BMP — every emoji, and plenty of CJK —
// occupies two units, and a cut between them strands half a pair: a replacement character that
// no longer survives a UTF-8 round trip. Chunk boundaries are safe on their own, since
// setEncoding buffers partial sequences and delivers a pair whole; only our own cut can split
// one, and only ever in two places (see `result`).
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

// Keeps the first and last HALF characters rather than a plain head cut: the useful parts of a
// long run sit at both ends — what it started doing, and the error it died on — and keeping
// only the head throws away the half that explains the failure.
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

      // Rolling window, so a process that never stops writing still cannot grow this past
      // MAX_OUTPUT_CHARS in memory.
      if (chunk) tail = (tail + chunk).slice(-HALF);
    },

    result(): { text: string; truncated: boolean } {
      // Anything at or under the cap survives whole: the two halves rejoin exactly, including
      // a surrogate pair sitting across the seam. Nothing to repair, so do not try.
      if (total <= head.length + tail.length) return { text: head + tail, truncated: false };

      // Only a real gap can strand a surrogate, and only in two places: the pair that straddled
      // the cut has its high half last in head and its low half first in tail, and they no
      // longer meet. A lone one can never end up anywhere else — head only ever grows at its
      // end, and the rolling window drops index 0 of tail the moment it slides again.
      const start = isHighSurrogate(head.charCodeAt(head.length - 1)) ? head.slice(0, -1) : head;
      const end = isLowSurrogate(tail.charCodeAt(0)) ? tail.slice(1) : tail;
      const omitted = total - start.length - end.length;
      return { text: `${start}\n... [${omitted} characters omitted] ...\n${end}`, truncated: true };
    },
  };
}

// Killing the child alone is not enough: verified on Windows that child.kill() reports success
// and leaves everything the shell started still running, so every timeout would leak a process.
function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }

  try {
    // The child was spawned into its own process group, so a negative pid signals the whole
    // group rather than just the shell that fronts it.
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already exited between the timer firing and this call. Nothing left to kill.
  }
}

export function spawnCollect(executable: string, args: string[], timeoutMs?: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group on POSIX so a timeout can reach the whole tree. Not on Windows,
      // where detached means a new console window instead.
      detached: process.platform !== "win32",
    });

    const out = createBoundedSink();
    const err = createBoundedSink();

    // Decoding per chunk would split multi-byte characters across stream boundaries and
    // corrupt any non-ASCII output; setEncoding buffers the partial sequence instead.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => out.write(chunk));
    child.stderr.on("data", (chunk: string) => err.write(chunk));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
    }, Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = out.result();
      const stderr = err.result();
      // Whatever the command managed to say before being killed still goes back. An agent can
      // diagnose a wedged build from its last output; it can do nothing with a bare timeout.
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
