import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeDarwinCompileOutput, stampDarwinCompileOutput } from "../../src/build/compile";
import {
  BUN_COMPILE_UUID_DARWIN_ARM64,
  BUN_COMPILE_UUID_DARWIN_X64,
  isBunCompileStubUuid,
  isDarwinCompileTarget,
  readMachOUuid,
  readMachOUuidFromFile,
  rewriteMachOUuidFile,
  stampMachOUuid,
} from "../../src/build/machoUuid";
import { MH_MAGIC_64, thinMachO } from "./thinMachO";

describe("isDarwinCompileTarget", () => {
  test("rewrites bun-darwin-arm64 even on a linux host", () => {
    expect(isDarwinCompileTarget("bun-darwin-arm64", "linux")).toBe(true);
  });

  test("leaves bun-linux-x64 untouched on a darwin host", () => {
    expect(isDarwinCompileTarget("bun-linux-x64", "darwin")).toBe(false);
  });

  test("rewrites a host build only on darwin", () => {
    expect(isDarwinCompileTarget(undefined, "darwin")).toBe(true);
    expect(isDarwinCompileTarget(undefined, "linux")).toBe(false);
  });
});

describe("stampMachOUuid", () => {
  test("negative control: a bun stub UUID stays a collision until stamped", () => {
    const bytes = thinMachO(BUN_COMPILE_UUID_DARWIN_ARM64, Buffer.from("payload-a"));
    expect(readMachOUuid(bytes)?.uuid).toBe(BUN_COMPILE_UUID_DARWIN_ARM64);
    expect(isBunCompileStubUuid(BUN_COMPILE_UUID_DARWIN_ARM64)).toBe(true);
    expect(isBunCompileStubUuid(BUN_COMPILE_UUID_DARWIN_X64)).toBe(true);
  });

  test("replaces the bun stub with a content-derived UUID", () => {
    const bytes = thinMachO(BUN_COMPILE_UUID_DARWIN_ARM64, Buffer.from("payload-a"));
    const result = stampMachOUuid(bytes);
    expect(result.kind).toBe("rewritten");
    if (result.kind !== "rewritten") throw new Error("expected rewrite");
    expect(result.before).toBe(BUN_COMPILE_UUID_DARWIN_ARM64);
    const stamped = readMachOUuid(bytes);
    if (stamped === undefined) throw new Error("missing uuid after stamp");
    expect(stamped.uuid).toBe(result.after);
    expect(result.after).not.toBe(BUN_COMPILE_UUID_DARWIN_ARM64);
    expect(isBunCompileStubUuid(result.after)).toBe(false);
    expect(result.after).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("second stamp is a no-op", () => {
    const bytes = thinMachO(BUN_COMPILE_UUID_DARWIN_ARM64, Buffer.from("payload-a"));
    const first = stampMachOUuid(bytes);
    const second = stampMachOUuid(bytes);
    expect(first.kind).toBe("rewritten");
    expect(second).toEqual({
      kind: "unchanged",
      uuid: first.kind === "rewritten" ? first.after : "",
    });
  });

  test("files that differ only in the old UUID converge", () => {
    const a = thinMachO(BUN_COMPILE_UUID_DARWIN_ARM64, Buffer.from("same-payload"));
    const b = thinMachO(BUN_COMPILE_UUID_DARWIN_X64, Buffer.from("same-payload"));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    const ra = stampMachOUuid(a);
    const rb = stampMachOUuid(b);
    expect(ra.kind).toBe("rewritten");
    expect(rb.kind).toBe("rewritten");
    if (ra.kind !== "rewritten" || rb.kind !== "rewritten") return;
    expect(ra.after).toBe(rb.after);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  test("different payloads get different UUIDs", () => {
    const a = thinMachO(BUN_COMPILE_UUID_DARWIN_ARM64, Buffer.from("a"));
    const b = thinMachO(BUN_COMPILE_UUID_DARWIN_ARM64, Buffer.from("b"));
    const ra = stampMachOUuid(a);
    const rb = stampMachOUuid(b);
    expect(ra.kind).toBe("rewritten");
    expect(rb.kind).toBe("rewritten");
    if (ra.kind !== "rewritten" || rb.kind !== "rewritten") return;
    expect(ra.after).not.toBe(rb.after);
  });

  test("skips ELF and UUID-less Mach-O", () => {
    expect(stampMachOUuid(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))).toEqual({
      kind: "skipped",
      reason: "not-mach-o",
    });
    const header = Buffer.alloc(32);
    header.writeUInt32LE(MH_MAGIC_64, 0);
    expect(stampMachOUuid(new Uint8Array(header))).toEqual({
      kind: "skipped",
      reason: "no-uuid",
    });
  });
});

describe("rewriteMachOUuidFile", () => {
  test("writes the stamped UUID and is readable from the header only", () => {
    const dir = mkdtempSync(join(tmpdir(), "seri-macho-"));
    try {
      const path = join(dir, "seri");
      writeFileSync(path, thinMachO(BUN_COMPILE_UUID_DARWIN_ARM64, Buffer.from("file")));
      const result = rewriteMachOUuidFile(path);
      expect(result.kind).toBe("rewritten");
      if (result.kind !== "rewritten") return;
      expect(readMachOUuidFromFile(path)?.uuid).toBe(result.after);
      expect(stampDarwinCompileOutput(path, "bun-linux-x64", "darwin")).toBeUndefined();
      const stamped = stampDarwinCompileOutput(path, "bun-darwin-arm64", "linux");
      expect(stamped).toEqual({ kind: "unchanged", uuid: result.after });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("finalizeDarwinCompileOutput", () => {
  test("rewrites a darwin target on linux without signing", () => {
    const dir = mkdtempSync(join(tmpdir(), "seri-macho-sign-"));
    try {
      const path = join(dir, "seri");
      writeFileSync(path, thinMachO(BUN_COMPILE_UUID_DARWIN_ARM64, Buffer.from("sign-linux")));
      const signed: string[] = [];
      const result = finalizeDarwinCompileOutput(path, "bun-darwin-arm64", "linux", (binPath) => {
        signed.push(binPath);
      });
      expect(result?.kind).toBe("rewritten");
      expect(signed).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("signs after a darwin-host rewrite because LC_UUID is covered by the signature", () => {
    const dir = mkdtempSync(join(tmpdir(), "seri-macho-sign-"));
    try {
      const path = join(dir, "seri");
      writeFileSync(path, thinMachO(BUN_COMPILE_UUID_DARWIN_ARM64, Buffer.from("sign-darwin")));
      const signed: string[] = [];
      const result = finalizeDarwinCompileOutput(path, "bun-darwin-arm64", "darwin", (binPath) => {
        signed.push(binPath);
      });
      expect(result?.kind).toBe("rewritten");
      expect(signed).toEqual([path]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not sign a skipped darwin output", () => {
    const dir = mkdtempSync(join(tmpdir(), "seri-macho-sign-"));
    try {
      const path = join(dir, "seri");
      const header = Buffer.alloc(32);
      header.writeUInt32LE(MH_MAGIC_64, 0);
      writeFileSync(path, header);
      const signed: string[] = [];
      expect(
        finalizeDarwinCompileOutput(path, "bun-darwin-arm64", "darwin", (binPath) => {
          signed.push(binPath);
        }),
      ).toEqual({ kind: "skipped", reason: "no-uuid" });
      expect(signed).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bun compile stub (real darwin target)", () => {
  test(
    "bun stamps the arm64 stub, then compile.ts rewrite diverges",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "seri-bun-darwin-"));
      try {
        const entry = join(dir, "main.ts");
        const outfile = join(dir, "seri");
        writeFileSync(entry, 'console.log("uuid-probe");\n');
        const build = spawnSync(
          process.execPath,
          ["build", "--compile", "--target", "bun-darwin-arm64", entry, "--outfile", outfile],
          { encoding: "utf8", timeout: 15_000 },
        );
        expect(build.status, build.stderr).toBe(0);
        const before = readMachOUuid(new Uint8Array(readFileSync(outfile)));
        expect(before?.uuid).toBe(BUN_COMPILE_UUID_DARWIN_ARM64);
        const stamped = stampDarwinCompileOutput(outfile, "bun-darwin-arm64", "linux");
        expect(stamped?.kind).toBe("rewritten");
        if (stamped?.kind !== "rewritten") return;
        expect(stamped.after).not.toBe(BUN_COMPILE_UUID_DARWIN_ARM64);
        expect(readMachOUuidFromFile(outfile)?.uuid).toBe(stamped.after);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    { timeout: 20_000 },
  );
});
