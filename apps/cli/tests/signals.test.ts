import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MODULE = pathToFileURL(join(import.meta.dir, "../src/signals.ts")).href;

// A child that registers a cancel handler, announces it is ready, and on the first press prints
// `cancelled`, waits, prints `unwound` and re-raises — the shape cli.ts has: cancel the turn, let
// it unwind, then still die by signal. The interval is what keeps it alive long enough for the
// press to land; the self-destruct is well past this test's own budget so it can never turn a red
// into a green.
const CHILD = [
  `const m = await import(${JSON.stringify(MODULE)});`,
  `m.onSignalCancel((sig) => {`,
  `  console.log("cancelled");`,
  `  setTimeout(() => { console.log("unwound"); m.raiseSignal(sig); }, 400);`,
  `});`,
  `console.log("ready");`,
  `setInterval(() => {}, 1000); setTimeout(() => process.exit(7), 30000);`,
].join("\n");

type Exit = { code: number | null; signal: NodeJS.Signals | null; stdout: string };

function startChild(): { child: ReturnType<typeof spawn>; exited: Promise<Exit>; sawLine: (line: string) => Promise<void> } {
  const child = spawn(process.execPath, ["-e", CHILD], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });

  const exited = new Promise<Exit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal, stdout }));
  });

  // Polled on the accumulated output rather than slept on: the press has to land after the module
  // was imported (which is what installs the handler) and after the cancel slot was registered.
  const sawLine = async (line: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!stdout.includes(line) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    if (!stdout.includes(line)) throw new Error(`child never printed ${JSON.stringify(line)}; got ${JSON.stringify(stdout)}`);
  };

  return { child, exited, sawLine };
}

// Windows terminates on process.kill(pid, "SIGINT") without running any registered listener, so
// none of this is observable there — measured on this project's dev box before the loop that
// added it. Real execution is the WSL box and CI's ubuntu/macos legs.
describe.skipIf(process.platform === "win32")("signal handling", () => {
  test("one press cancels without killing, and the process still exits BY signal", async () => {
    // The assertion is the exit disposition, not how many iterations a shell loop ran. Measured
    // while planning: `for f in a b c; do child "$f"; done` runs 3 iterations with AND without the
    // re-raise under a non-interactive shell, a signal to the group, a signal to the child alone,
    // and a pty — only an interactive `bash -i` with a real \003 discriminates. `signal ===
    // "SIGINT"` / `code === null` IS the 128 + n contract, and it discriminates everywhere.
    const { child, exited, sawLine } = startChild();
    try {
      await sawLine("ready");
      child.kill("SIGINT");

      const exit = await exited;
      expect(exit.stdout).toContain("cancelled");
      expect(exit.stdout).toContain("unwound");
      expect(exit.signal).toBe("SIGINT");
      expect(exit.code).toBeNull();
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);

  test("a SIGTERM terminates instead of cancelling, even with a cancel registered", async () => {
    // The senders that matter here never press twice: `timeout 30 seri …`, systemd's stop, a CI
    // job canceller. Asserting that the cancel callback did NOT run is the whole point — the same
    // registration that makes SIGINT non-fatal must leave SIGTERM alone.
    const { child, exited, sawLine } = startChild();
    try {
      await sawLine("ready");
      child.kill("SIGTERM");

      const exit = await exited;
      expect(exit.stdout).not.toContain("cancelled");
      expect(exit.signal).toBe("SIGTERM");
      expect(exit.code).toBeNull();
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);

  test("a second press skips the unwind and still exits by signal", async () => {
    const { child, exited, sawLine } = startChild();
    try {
      await sawLine("ready");
      child.kill("SIGINT");
      // Sent as soon as the first press is known to have been handled, which is inside the 400 ms
      // the unwind takes — that window is the thing being tested.
      await sawLine("cancelled");
      child.kill("SIGINT");

      const exit = await exited;
      expect(exit.stdout).not.toContain("unwound");
      expect(exit.signal).toBe("SIGINT");
      expect(exit.code).toBeNull();
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);
});
