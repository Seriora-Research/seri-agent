import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import pkg from "../../package.json";
import {
  checksumForAsset,
  releaseAssetName,
  runUpdate,
  stripReleaseTag,
} from "../../src/update/run";

describe("releaseAssetName", () => {
  test("matches install.sh names", () => {
    expect(releaseAssetName("linux", "x64")).toBe("seri-linux-x64");
    expect(releaseAssetName("linux", "arm64")).toBe("seri-linux-arm64");
    expect(releaseAssetName("darwin", "x64")).toBe("seri-darwin-x64");
    expect(releaseAssetName("darwin", "arm64")).toBe("seri-darwin-arm64");
    expect(releaseAssetName("win32", "x64")).toBe("seri-windows-x64.exe");
    expect(releaseAssetName("win32", "arm64")).toBeUndefined();
    expect(releaseAssetName("freebsd", "x64")).toBeUndefined();
  });
});

describe("checksumForAsset", () => {
  test("reads the two SHA256SUMS spellings install.sh accepts", () => {
    const sums =
      "abc\tseri-linux-x64\n0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  *seri-linux-arm64\n";
    expect(checksumForAsset(sums, "seri-linux-x64")).toBeUndefined();
    const hex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(checksumForAsset(`${hex}  seri-linux-x64\n`, "seri-linux-x64")).toBe(hex);
    expect(checksumForAsset(`${hex}  *seri-linux-x64\n`, "seri-linux-x64")).toBe(hex);
  });
});

describe("stripReleaseTag", () => {
  test("drops a leading v", () => {
    expect(stripReleaseTag("v0.1.0")).toBe("0.1.0");
    expect(stripReleaseTag("0.1.0")).toBe("0.1.0");
  });
});

describe("runUpdate", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function tmpSeri(): string {
    const dir = mkdtempSync(join(tmpdir(), "seri-update-"));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "seri");
    writeFileSync(path, "old-binary");
    return path;
  }

  test("refuses when execPath is bun, not a seri binary", async () => {
    const result = await runUpdate({
      fetch: async () => {
        throw new Error("fetch must not run");
      },
      execPath: "/usr/bin/bun",
      env: {},
      platform: "linux",
      arch: "x64",
      version: pkg.version,
    });
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("running from source");
  });

  test("exits 0 when latest matches the running version", async () => {
    let fetched = "";
    const result = await runUpdate({
      fetch: async (input) => {
        fetched = String(input);
        return new Response(JSON.stringify({ tag_name: `v${pkg.version}`, prerelease: false }), {
          status: 200,
        });
      },
      execPath: tmpSeri(),
      env: {},
      platform: "linux",
      arch: "x64",
      version: pkg.version,
    });
    expect(result).toEqual({ code: 0, lines: [`seri ${pkg.version} is current`] });
    expect(fetched).toContain("releases/latest");
  });

  test("leaves the original bytes when the checksum does not match", async () => {
    const path = tmpSeri();
    const payload = new TextEncoder().encode("new-binary");
    const result = await runUpdate({
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("releases/latest") && url.includes("api.github.com")) {
          return new Response(JSON.stringify({ tag_name: "v9.9.9", prerelease: false }), {
            status: 200,
          });
        }
        if (url.endsWith("SHA256SUMS")) {
          return new Response(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  seri-linux-x64\n",
            { status: 200 },
          );
        }
        if (url.endsWith("seri-linux-x64")) {
          return new Response(payload, { status: 200 });
        }
        return new Response("missing", { status: 404 });
      },
      execPath: path,
      env: {},
      platform: "linux",
      arch: "x64",
      version: pkg.version,
      smoke: async () => {
        throw new Error("smoke must not run after a checksum mismatch");
      },
    });
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain("checksum mismatch");
    expect(readFileSync(path, "utf8")).toBe("old-binary");
  });

  test("replaces the binary after a matching checksum", async () => {
    const path = tmpSeri();
    const payload = new TextEncoder().encode("new-binary");
    const hex = createHash("sha256").update(payload).digest("hex");
    const result = await runUpdate({
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("api.github.com")) {
          return new Response(JSON.stringify({ tag_name: "v9.9.9", prerelease: false }), {
            status: 200,
          });
        }
        if (url.endsWith("SHA256SUMS")) {
          return new Response(`${hex}  seri-linux-x64\n`, { status: 200 });
        }
        if (url.endsWith("seri-linux-x64")) {
          return new Response(payload, { status: 200 });
        }
        return new Response("missing", { status: 404 });
      },
      execPath: path,
      env: {},
      platform: "linux",
      arch: "x64",
      version: pkg.version,
      smoke: async () => {},
    });
    expect(result.code).toBe(0);
    expect(result.lines[0]).toContain(`updated seri ${pkg.version} → 9.9.9`);
    expect(readFileSync(path, "utf8")).toBe("new-binary");
  });

  test("pins SERI_VERSION and skips the latest endpoint", async () => {
    const path = tmpSeri();
    const fetched: string[] = [];
    const result = await runUpdate({
      fetch: async (input) => {
        fetched.push(String(input));
        return new Response("unused", { status: 500 });
      },
      execPath: path,
      env: { SERI_VERSION: `v${pkg.version}` },
      platform: "linux",
      arch: "x64",
      version: pkg.version,
    });
    expect(result).toEqual({ code: 0, lines: [`seri ${pkg.version} is current`] });
    expect(fetched).toEqual([]);
  });

  test("refuses a prerelease latest tag", async () => {
    const result = await runUpdate({
      fetch: async () =>
        new Response(JSON.stringify({ tag_name: "v9.9.9", prerelease: true }), { status: 200 }),
      execPath: tmpSeri(),
      env: {},
      platform: "linux",
      arch: "x64",
      version: pkg.version,
    });
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("prerelease");
  });

  test("treats a 404 latest release as a clear failure", async () => {
    const result = await runUpdate({
      fetch: async () => new Response("Not Found", { status: 404 }),
      execPath: tmpSeri(),
      env: {},
      platform: "linux",
      arch: "x64",
      version: pkg.version,
    });
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("no GitHub release yet");
  });
});
