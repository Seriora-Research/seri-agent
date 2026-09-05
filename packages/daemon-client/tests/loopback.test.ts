import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalizeLoopbackHost,
  canonicalizeLoopbackUrl,
  DaemonClient,
  readDaemonDescriptor,
} from "../src/index";

describe("canonicalizeLoopbackHost", () => {
  test("rewrites the mapped form and its expanded and hex variants to 127.0.0.1", () => {
    expect(canonicalizeLoopbackHost("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(canonicalizeLoopbackHost("::FFFF:127.0.0.1")).toBe("127.0.0.1");
    expect(canonicalizeLoopbackHost("[::ffff:127.0.0.1]")).toBe("127.0.0.1");
    expect(canonicalizeLoopbackHost("0:0:0:0:0:ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(canonicalizeLoopbackHost("::ffff:7f00:1")).toBe("127.0.0.1");
    expect(canonicalizeLoopbackHost("[::ffff:7f00:1]")).toBe("127.0.0.1");
    expect(canonicalizeLoopbackHost("0:0:0:0:0:ffff:7f00:1")).toBe("127.0.0.1");
  });

  test("leaves ::1 as ::1", () => {
    expect(canonicalizeLoopbackHost("::1")).toBe("::1");
    expect(canonicalizeLoopbackHost("[::1]")).toBe("::1");
  });

  test("leaves localhost as localhost", () => {
    expect(canonicalizeLoopbackHost("localhost")).toBe("localhost");
    expect(canonicalizeLoopbackHost("LOCALHOST")).toBe("LOCALHOST");
  });

  test("leaves a non-loopback host unchanged", () => {
    expect(canonicalizeLoopbackHost("example.com")).toBe("example.com");
    expect(canonicalizeLoopbackHost("::ffff:8.8.8.8")).toBe("::ffff:8.8.8.8");
  });
});

describe("canonicalizeLoopbackUrl", () => {
  test("rewrites a mapped host and preserves port, path, and query", () => {
    expect(canonicalizeLoopbackUrl("http://[::ffff:127.0.0.1]:9/v1")).toBe("http://127.0.0.1:9/v1");
    expect(canonicalizeLoopbackUrl("http://[::ffff:7f00:1]:9/v1")).toBe("http://127.0.0.1:9/v1");
    expect(canonicalizeLoopbackUrl("http://[::ffff:127.0.0.1]:9/v1?x=1")).toBe(
      "http://127.0.0.1:9/v1?x=1",
    );
  });

  test("leaves ::1 as ::1", () => {
    expect(canonicalizeLoopbackUrl("http://[::1]:9/v1")).toBe("http://[::1]:9/v1");
  });

  test("leaves localhost as localhost", () => {
    expect(canonicalizeLoopbackUrl("http://localhost:9/v1")).toBe("http://localhost:9/v1");
  });

  test("leaves a non-loopback host unchanged", () => {
    expect(canonicalizeLoopbackUrl("http://example.com:9/v1")).toBe("http://example.com:9/v1");
    expect(canonicalizeLoopbackUrl("http://Example.COM:9/v1?x=%2F")).toBe(
      "http://Example.COM:9/v1?x=%2F",
    );
  });

  test("returns invalid input unchanged", () => {
    expect(canonicalizeLoopbackUrl("not a url")).toBe("not a url");
  });
});

describe("DaemonClient", () => {
  test("fetches 127.0.0.1 when constructed with a mapped endpoint", async () => {
    const requested: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({ v: 1, pid: 7 });
      },
    });
    try {
      const client = new DaemonClient({
        endpoint: `http://[::ffff:127.0.0.1]:${server.port}`,
        token: "secret-token",
        fetch: ((...args: Parameters<typeof fetch>) => {
          requested.push(String(args[0]));
          return fetch(...args);
        }) as typeof fetch,
      });
      await client.health();
    } finally {
      server.stop();
    }
    expect(requested).toHaveLength(1);
    const url = new URL(requested[0]!);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.pathname).toBe("/v1/health");
  });

  test("keeps a localhost endpoint so a registered redirect URI still matches", async () => {
    const requested: string[] = [];
    const client = new DaemonClient({
      endpoint: "http://localhost:9/v1",
      token: "secret-token",
      fetch: ((...args: Parameters<typeof fetch>) => {
        requested.push(String(args[0]));
        return Promise.resolve(Response.json({ v: 1, pid: 7 }));
      }) as typeof fetch,
    });
    await client.health();
    expect(requested).toHaveLength(1);
    expect(new URL(requested[0]!).hostname).toBe("localhost");
  });

  test("readDaemonDescriptor rewrites a mapped endpoint so it cannot leak to fetch", () => {
    const dir = mkdtempSync(join(tmpdir(), "seri-daemon-loopback-"));
    try {
      const path = join(dir, "descriptor.json");
      writeFileSync(
        path,
        JSON.stringify({
          v: 1,
          endpoint: "http://[::ffff:127.0.0.1]:9/v1",
          token: "t",
          pid: 1,
          startedAt: "now",
        }),
      );
      expect(readDaemonDescriptor(path).endpoint).toBe("http://127.0.0.1:9/v1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
