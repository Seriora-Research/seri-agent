import { afterEach, describe, expect, test } from "bun:test";
import { spawn as spawnReal } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectCodexAppServer } from "../../src/auth/codexAppServer";

const FAKE_SERVER = `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line.length === 0) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { userAgent: "seri/test" } }) + "\\n");
  } else if (msg.method === "account/read") {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { account: { type: "chatgpt" } } }) + "\\n");
  }
});
`;

describe("connectCodexAppServer", () => {
  let dir: string;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  test("handshakes as seri then serves account/read", async () => {
    dir = mkdtempSync(join(tmpdir(), "seri-codex-rpc-"));
    const script = join(dir, "fake-codex.mjs");
    writeFileSync(script, FAKE_SERVER);
    const rpc = await connectCodexAppServer({
      command: process.execPath,
      spawn: (cmd, args, opts) => spawnReal(cmd, [script, ...args], opts),
      timeoutMs: 5000,
    });
    try {
      const result = await rpc.request("account/read", { refreshToken: true });
      expect(result).toEqual({ account: { type: "chatgpt" } });
    } finally {
      rpc.close();
    }
  });
});
