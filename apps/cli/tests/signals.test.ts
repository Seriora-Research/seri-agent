import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MODULE = pathToFileURL(join(import.meta.dir, "../src/signals.ts")).href;






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

function startChild(): {
  child: ReturnType<typeof spawn>;
  exited: Promise<Exit>;
  sawLine: (line: string) => Promise<void>;
} {
  const child = spawn(process.execPath, ["-e", CHILD], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });

  const exited = new Promise<Exit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal, stdout }));
  });



  const sawLine = async (line: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!stdout.includes(line) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    if (!stdout.includes(line))
      throw new Error(`child never printed ${JSON.stringify(line)}; got ${JSON.stringify(stdout)}`);
  };

  return { child, exited, sawLine };
}




describe.skipIf(process.platform === "win32")("signal handling", () => {
  test("one press cancels without killing, and the process still exits BY signal", async () => {





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
