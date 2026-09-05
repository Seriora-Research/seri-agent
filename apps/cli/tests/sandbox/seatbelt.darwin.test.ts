import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { seatbeltLoopbackAllow } from "../../src/sandbox/macos/seatbelt";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const PYTHON = "/usr/bin/python3";

function denyDefaultPlusLoopback(): string {
  return [
    "(version 1)",
    "(deny default)",
    "(allow file-read*)",
    '(allow file-write* (subpath "/tmp") (subpath "/private/tmp"))',
    "(allow process-exec*)",
    "(allow process-fork)",
    "(allow signal)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow system-socket)",
    seatbeltLoopbackAllow(),
  ].join("\n");
}

const CONNECT_SCRIPT = `
import socket, sys
host, port = sys.argv[1], int(sys.argv[2])
family = socket.AF_INET6 if ":" in host else socket.AF_INET
sock = socket.socket(family, socket.SOCK_STREAM)
sock.settimeout(2)
try:
    sock.connect((host, port))
    print("ok")
except OSError as err:
    print(err.errno, err.strerror, file=sys.stderr)
    sys.exit(1)
finally:
    sock.close()
`;

function runSandboxedConnect(
  host: string,
  port: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      SANDBOX_EXEC,
      ["-p", denyDefaultPlusLoopback(), PYTHON, "-c", CONNECT_SCRIPT, host, String(port)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function deniedBySandbox(result: { exitCode: number; stderr: string }): boolean {
  if (result.exitCode === 0) return false;
  return (
    result.stderr.includes("Operation not permitted") ||
    result.stderr.includes("EPERM") ||
    result.stderr.startsWith("1 ")
  );
}

describe.skipIf(process.platform !== "darwin" || !existsSync(SANDBOX_EXEC))(
  "seatbelt loopback allow under sandbox-exec",
  () => {
    test("127.0.0.1 and ::1 connect; mapped form and non-loopback stay denied", async () => {
      const v4 = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("ok"),
      });
      if (v4.port === undefined) throw new Error("no v4 port was assigned");
      const v4Port = v4.port;
      let v6: ReturnType<typeof Bun.serve> | undefined;
      try {
        try {
          v6 = Bun.serve({
            hostname: "::1",
            port: 0,
            fetch: () => new Response("ok"),
          });
        } catch {
          v6 = undefined;
        }

        const allowedV4 = await runSandboxedConnect("127.0.0.1", v4Port);
        expect(allowedV4.exitCode).toBe(0);
        expect(allowedV4.stdout).toContain("ok");

        if (v6 !== undefined && v6.port !== undefined) {
          const allowedV6 = await runSandboxedConnect("::1", v6.port);
          expect(allowedV6.exitCode).toBe(0);
          expect(allowedV6.stdout).toContain("ok");
        }

        const mapped = await runSandboxedConnect("::ffff:127.0.0.1", v4Port);
        expect(deniedBySandbox(mapped)).toBe(true);

        const remote = await runSandboxedConnect("1.1.1.1", 443);
        expect(remote.exitCode).not.toBe(0);
      } finally {
        v4.stop();
        v6?.stop();
      }
    }, 15_000);
  },
);
