import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seatbeltLoopbackAllow } from "../../src/sandbox/macos/seatbelt";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

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

// POSIX connect(2), compiled outside the sandbox. /usr/bin/python3 on
// macos-latest exits 72 under (deny default) before the script runs. bun
// and node:net remap ::ffff:127.0.0.1 onto AF_INET, so the mapped-form
// deny looks like a successful localhost connect (CI: deniedBySandbox false).
const CONNECT_C = `
#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
static void fail(void) {
  fprintf(stderr, "%d %s\\n", errno, strerror(errno));
  exit(1);
}
int main(int argc, char **argv) {
  if (argc < 3) return 2;
  const char *host = argv[1];
  int port = atoi(argv[2]);
  int v6 = strchr(host, ':') != NULL;
  int fd = socket(v6 ? AF_INET6 : AF_INET, SOCK_STREAM, 0);
  if (fd < 0) fail();
  struct timeval tv = {.tv_sec = 2, .tv_usec = 0};
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  int rc;
  if (v6) {
    struct sockaddr_in6 a;
    memset(&a, 0, sizeof a);
#ifdef __APPLE__
    a.sin6_len = sizeof a;
#endif
    a.sin6_family = AF_INET6;
    a.sin6_port = htons((unsigned short)port);
    if (inet_pton(AF_INET6, host, &a.sin6_addr) != 1) fail();
    rc = connect(fd, (struct sockaddr *)&a, sizeof a);
  } else {
    struct sockaddr_in a;
    memset(&a, 0, sizeof a);
#ifdef __APPLE__
    a.sin_len = sizeof a;
#endif
    a.sin_family = AF_INET;
    a.sin_port = htons((unsigned short)port);
    if (inet_pton(AF_INET, host, &a.sin_addr) != 1) fail();
    rc = connect(fd, (struct sockaddr *)&a, sizeof a);
  }
  if (rc == 0) {
    puts("ok");
    close(fd);
    return 0;
  }
  close(fd);
  fail();
}
`;

function compileConnectProbe(): { bin: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "seatbelt-connect-"));
  const src = join(dir, "connect.c");
  const bin = join(dir, "connect");
  writeFileSync(src, CONNECT_C);
  const result = spawnSync("cc", ["-o", bin, src], { encoding: "utf8" });
  if (result.status !== 0 || !existsSync(bin)) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`cc failed: ${result.stderr || result.stdout || result.status}`);
  }
  return { bin, dir };
}

function runSandboxedConnect(
  bin: string,
  host: string,
  port: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      SANDBOX_EXEC,
      ["-p", denyDefaultPlusLoopback(), bin, host, String(port)],
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
      const probe = compileConnectProbe();
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

        const allowedV4 = await runSandboxedConnect(probe.bin, "127.0.0.1", v4Port);
        expect(allowedV4.exitCode, allowedV4.stderr).toBe(0);
        expect(allowedV4.stdout).toContain("ok");

        if (v6 !== undefined && v6.port !== undefined) {
          const allowedV6 = await runSandboxedConnect(probe.bin, "::1", v6.port);
          expect(allowedV6.exitCode, allowedV6.stderr).toBe(0);
          expect(allowedV6.stdout).toContain("ok");
        }

        const mapped = await runSandboxedConnect(probe.bin, "::ffff:127.0.0.1", v4Port);
        expect(deniedBySandbox(mapped), `${mapped.exitCode} ${mapped.stderr}`).toBe(true);

        const remote = await runSandboxedConnect(probe.bin, "1.1.1.1", 443);
        expect(remote.exitCode, remote.stderr).not.toBe(0);
      } finally {
        v4.stop();
        v6?.stop();
        rmSync(probe.dir, { recursive: true, force: true });
      }
    }, 15_000);
  },
);
