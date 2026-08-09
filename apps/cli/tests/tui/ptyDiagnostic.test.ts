// TEMPORARY diagnostic — not a real test, to be deleted once the ubuntu-latest/macos-latest CI
// pty-input failure (tuiPty.test.ts: "child never printed X" on every keystroke-driven test) is
// understood. WSL2 passes all 15 of those tests; CI has never passed them. This isolates the raw
// mechanism (python3's pty.spawn + a bun child reading stdin) from any real seri/Ink code, to see
// what CI's own environment actually reports before guessing at a fix.
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe.skipIf(process.platform === "win32")("pty diagnostic (temporary)", () => {
  test("reports isTTY and raw-mode stdin echo behavior inside a python3 pty.spawn child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seri-pty-diag-"));
    const scriptPath = join(dir, "diag.mjs");
    writeFileSync(
      scriptPath,
      [
        `console.log("DIAG stdout.isTTY=" + process.stdout.isTTY);`,
        `console.log("DIAG stdin.isTTY=" + process.stdin.isTTY);`,
        `console.log("DIAG platform=" + process.platform + " bunVersion=" + Bun.version);`,
        `try {`,
        `  process.stdin.setRawMode(true);`,
        `  console.log("DIAG setRawMode(true) succeeded");`,
        `} catch (err) {`,
        `  console.log("DIAG setRawMode threw: " + (err instanceof Error ? err.message : String(err)));`,
        `}`,
        `process.stdin.resume();`,
        `process.stdin.on("data", (d) => console.log("DIAG got chunk: " + JSON.stringify(d.toString())));`,
        `setTimeout(() => process.exit(0), 3000);`,
      ].join("\n"),
    );

    const args = ["-c", "import pty, sys; pty.spawn(sys.argv[1:])", process.execPath, scriptPath];
    const child = spawn("python3", args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    // Give the child time to print its startup DIAG lines and call setRawMode before writing.
    await new Promise((resolve) => setTimeout(resolve, 800));
    child.stdin?.write("hello");

    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    rmSync(dir, { recursive: true, force: true });

    console.log(`FULL DIAG OUTPUT (${process.platform}):\n${stdout}`);
    // Always "passes" — this test exists purely to get the DIAG lines above into the CI log.
    expect(true).toBe(true);
  }, 15_000);
});
