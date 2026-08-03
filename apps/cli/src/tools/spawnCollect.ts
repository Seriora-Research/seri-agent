import { spawn } from "node:child_process";

export type ProcessResult = { stdout: string; stderr: string; exitCode: number; truncated: boolean };

// Both streams were accumulated into unbounded strings, so a runaway command (`yes`, a `cat`
// of a large file, a build log) grew the process until it died and, short of that, handed the
// model an output no context window could hold. Claude Code caps command output at the same
// 30k characters for the same two reasons.
const MAX_OUTPUT_CHARS = 30_000;
const HALF = MAX_OUTPUT_CHARS / 2;

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
      const omitted = total - head.length - tail.length;
      // Anything at or under the cap survives whole; head and tail simply rejoin.
      if (omitted <= 0) return { text: head + tail, truncated: false };
      return { text: `${head}\n... [${omitted} characters omitted] ...\n${tail}`, truncated: true };
    },
  };
}

export function spawnCollect(executable: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = createBoundedSink();
    const err = createBoundedSink();

    // Decoding per chunk would split multi-byte characters across stream boundaries and
    // corrupt any non-ASCII output; setEncoding buffers the partial sequence instead.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => out.write(chunk));
    child.stderr.on("data", (chunk: string) => err.write(chunk));

    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = out.result();
      const stderr = err.result();
      resolve({
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode: code ?? 1,
        truncated: stdout.truncated || stderr.truncated,
      });
    });
  });
}
