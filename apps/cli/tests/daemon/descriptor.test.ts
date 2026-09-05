import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDaemonDescriptorPath, getDaemonLockPath } from "../../src/config/paths";
import {
  acquireDaemonLock,
  DaemonAlreadyRunningError,
  readDaemonDescriptorFile,
  removeOwnedDescriptor,
  writeDaemonDescriptor,
} from "../../src/daemon/descriptor";
import { startDaemon } from "../../src/daemon/server";

let dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seri-daemon-desc-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("daemon descriptor and lock", () => {
  test("a second daemon for the same profile fails while the first is alive", async () => {
    const configDir = makeDir();
    const first = await startDaemon({
      configDir,
      executeTurn: async (input) => {
        input.emitLoop({ type: "done", reason: "no-tool-call" });
        return { exitCode: 0 };
      },
    });
    await expect(
      startDaemon({
        configDir,
        executeTurn: async () => ({ exitCode: 0 }),
      }),
    ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
    await first.stop();
  });

  test("acquireDaemonLock creates a missing config directory", () => {
    const parent = makeDir();
    const configDir = join(parent, ".seri");
    expect(existsSync(configDir)).toBe(false);
    const lock = acquireDaemonLock(configDir);
    expect(existsSync(getDaemonLockPath(configDir))).toBe(true);
    lock.release();
  });

  test("stale lock and descriptor are recovered when the recorded pid is dead", () => {
    const configDir = makeDir();
    writeFileSync(getDaemonLockPath(configDir), "999999999\n");
    writeDaemonDescriptor(configDir, {
      v: 1,
      endpoint: "http://127.0.0.1:1",
      token: "stale",
      pid: 999999999,
      startedAt: new Date().toISOString(),
    });
    const lock = acquireDaemonLock(configDir);
    expect(statSync(getDaemonLockPath(configDir)).isFile()).toBe(true);
    lock.release();
  });

  test("shutdown removes only the descriptor owned by that daemon token", async () => {
    const configDir = makeDir();
    const daemon = await startDaemon({
      configDir,
      executeTurn: async (input) => {
        input.emitLoop({ type: "done", reason: "no-tool-call" });
        return { exitCode: 0 };
      },
    });
    const owned = readDaemonDescriptorFile(configDir);
    expect(owned?.token).toBe(daemon.token);
    if (process.platform !== "win32") {
      expect(statSync(getDaemonDescriptorPath(configDir)).mode & 0o777).toBe(0o600);
    }

    writeDaemonDescriptor(configDir, { ...owned!, token: "other-token" });
    await daemon.stop();
    expect(readDaemonDescriptorFile(configDir)?.token).toBe("other-token");

    removeOwnedDescriptor(configDir, "other-token");
    expect(readDaemonDescriptorFile(configDir)).toBeUndefined();
  });

  test("stop removes the matching descriptor", async () => {
    const configDir = makeDir();
    const daemon = await startDaemon({
      configDir,
      executeTurn: async (input) => {
        input.emitLoop({ type: "done", reason: "no-tool-call" });
        return { exitCode: 0 };
      },
    });
    await daemon.stop();
    expect(readDaemonDescriptorFile(configDir)).toBeUndefined();
  });

  test("mapped loopback endpoints are stored and read as 127.0.0.1", () => {
    const configDir = makeDir();
    writeDaemonDescriptor(configDir, {
      v: 1,
      endpoint: "http://[::ffff:127.0.0.1]:9",
      token: "t",
      pid: 1,
      startedAt: "now",
    });
    expect(readDaemonDescriptorFile(configDir)?.endpoint).toBe("http://127.0.0.1:9");
    const stored = JSON.parse(readFileSync(getDaemonDescriptorPath(configDir), "utf8")) as {
      endpoint: string;
    };
    expect(stored.endpoint).toBe("http://127.0.0.1:9");

    writeFileSync(
      getDaemonDescriptorPath(configDir),
      `${JSON.stringify({
        v: 1,
        endpoint: "http://[::ffff:127.0.0.1]:9",
        token: "t",
        pid: 1,
        startedAt: "now",
      })}\n`,
    );
    expect(readDaemonDescriptorFile(configDir)?.endpoint).toBe("http://127.0.0.1:9");
  });

  test("a truncated descriptor is treated as absent", () => {
    const configDir = makeDir();
    writeFileSync(getDaemonDescriptorPath(configDir), "{not json");
    expect(readDaemonDescriptorFile(configDir)).toBeUndefined();
    expect(() => removeOwnedDescriptor(configDir, "any")).not.toThrow();
  });

  test("a failed descriptor write releases the lock so a later start can proceed", async () => {
    const configDir = makeDir();
    mkdirSync(getDaemonDescriptorPath(configDir));
    await expect(
      startDaemon({
        configDir,
        executeTurn: async () => ({ exitCode: 0 }),
      }),
    ).rejects.toThrow();
    const lock = acquireDaemonLock(configDir);
    lock.release();
  });

  test("a failed legacy import releases the lock so a later start can proceed", async () => {
    const configDir = makeDir();
    writeFileSync(join(configDir, "sessions"), "not a directory");
    await expect(
      startDaemon({
        configDir,
        executeTurn: async () => ({ exitCode: 0 }),
      }),
    ).rejects.toThrow();
    const lock = acquireDaemonLock(configDir);
    lock.release();
  });
});
