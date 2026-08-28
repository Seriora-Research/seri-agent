import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "@seri/daemon-client";
import { getDaemonDescriptorPath } from "../../src/config/paths";

const bin = process.env.SERI_BIN ?? join(import.meta.dir, "../../dist/seri");

let dirs: string[] = [];
let child: ReturnType<typeof Bun.spawn> | undefined;

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seri-compiled-daemon-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  if (child !== undefined) {
    child.kill("SIGTERM");
    await child.exited;
    child = undefined;
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await Bun.sleep(20);
  }
  return existsSync(path);
}

describe.skipIf(!existsSync(bin))("compiled seri serve", () => {
  test("binds loopback, requires the bearer, and removes the descriptor on SIGTERM", async () => {
    const home = makeDir();
    const descriptorPath = getDaemonDescriptorPath(join(home, ".seri"));
    child = Bun.spawn([bin, "serve"], {
      env: { ...process.env, HOME: home, SERI_DISABLE_MODELS_FETCH: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await waitFor(descriptorPath, 8000)).toBe(true);
    const descriptor = JSON.parse(await Bun.file(descriptorPath).text()) as {
      endpoint: string;
      token: string;
    };
    expect(descriptor.endpoint).toContain("127.0.0.1");
    const unauth = await fetch(`${descriptor.endpoint}/v1/health`);
    expect(unauth.status).toBe(401);
    const client = new DaemonClient({
      endpoint: descriptor.endpoint,
      token: descriptor.token,
    });
    const health = await client.health();
    expect(health.v).toBe(1);
    child.kill("SIGTERM");
    await child.exited;
    child = undefined;
    const gone = Date.now() + 2000;
    while (existsSync(descriptorPath) && Date.now() < gone) await Bun.sleep(20);
    expect(existsSync(descriptorPath)).toBe(false);
  });

  test("seri exec without a daemon exits 1", async () => {
    const home = makeDir();
    const proc = Bun.spawn([bin, "exec", "ready"], {
      env: { ...process.env, HOME: home },
      stderr: "pipe",
      stdout: "pipe",
    });
    const code = await proc.exited;
    const err = await new Response(proc.stderr).text();
    expect(code).toBe(1);
    expect(err).toContain("no daemon is running");
  });
});
