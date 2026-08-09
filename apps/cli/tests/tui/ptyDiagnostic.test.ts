// TEMPORARY diagnostic — not a real test, to be deleted once the ubuntu-latest/macos-latest CI
// pty-input failure (tuiPty.test.ts: "child never printed X" on every keystroke-driven test) is
// understood. WSL2 passes all 15 of those tests; CI has never passed them.
//
// Round 1 (isolated python3 pty.spawn + a bare bun stdin.setRawMode script, no Ink/React at all)
// came back identical on ubuntu-latest/macos-latest/WSL2: isTTY=true on both stdout/stdin,
// setRawMode succeeds, a written chunk arrives. The raw OS/pty/bun mechanism is not the problem.
//
// Round 2 (this file): the REAL cli.run() TUI, same shape tuiPty.test.ts's own childScriptInput
// uses, but with an extra fixed delay AFTER RUNLOOP_READY before writing — testing whether this is
// purely a race (something not yet wired despite RUNLOOP_READY having fired) that a longer wait
// closes, as opposed to a structural failure that no amount of waiting fixes. A raw process.stdin
// 'data' listener is attached (Node broadcasts 'data' to every listener, so this does not steal
// bytes from Ink's own) to see whether the OS-level byte reaches the process at all, independent of
// whether Ink itself renders it.
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CLI = pathToFileURL(join(import.meta.dir, "../../src/cli.ts")).href;

function childScript(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `process.stdin.on("data", (d) => console.log("DIAG raw stdin data: " + JSON.stringify(d.toString())));`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY isRaw=" + process.stdin.isRaw);`,
    `  await new Promise(() => {});`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

describe.skipIf(process.platform === "win32")("pty diagnostic round 2 (temporary)", () => {
  test("a long delay after RUNLOOP_READY before writing /mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seri-pty-diag2-"));
    const scriptPath = join(dir, "diag2.mjs");
    writeFileSync(scriptPath, childScript(dir));

    const args = ["-c", "import pty, sys; pty.spawn(sys.argv[1:])", process.execPath, scriptPath];
    const child = spawn("python3", args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    const deadline = Date.now() + 20_000;
    while (!stdout.includes("RUNLOOP_READY") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    console.log(`DIAG saw RUNLOOP_READY after ${20_000 - (deadline - Date.now())}ms of polling`);

    // The long, deliberate part: 5s of nothing, then write, then wait another 5s before giving up
    // — if this passes where the un-delayed version fails, it is a race; if it still never sees
    // the byte reflected, the delay is not the variable.
    await new Promise((r) => setTimeout(r, 5000));
    child.stdin?.write("/mode");

    const writeDeadline = Date.now() + 10_000;
    while (!stdout.includes("/mode") && Date.now() < writeDeadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    console.log(`FULL DIAG OUTPUT (${process.platform}):\n${stdout}`);
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });

    // Always "passes" — this test exists purely to get the DIAG lines above into the CI log.
    expect(true).toBe(true);
  }, 30_000);
});
