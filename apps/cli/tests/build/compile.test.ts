import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  compileArgs,
  linuxOpentuiNativePackage,
  resolveBuildCommit,
  stripPackedLinuxOpentuiNative,
} from "../../src/build/compile";

describe("resolveBuildCommit", () => {
  test("prefers SERI_BUILD_COMMIT over git", () => {
    expect(resolveBuildCommit({ SERI_BUILD_COMMIT: "abc123" }, () => "deadbeef".repeat(5))).toBe(
      "abc123",
    );
  });

  test("falls back to git when env is unset", () => {
    expect(resolveBuildCommit({}, () => "deadbeef".repeat(5))).toBe("deadbeef".repeat(5));
  });

  test("omits commit when neither env nor git is available", () => {
    expect(resolveBuildCommit({}, () => undefined)).toBeUndefined();
  });
});

describe("compileArgs", () => {
  test("passes --define SERI_BAKED_COMMIT when a commit is known", () => {
    expect(
      compileArgs({
        entry: "./src/cli.ts",
        outfile: "dist/seri",
        commit: "cafebabecafebabecafebabecafebabecafebabe",
        platform: "darwin",
      }),
    ).toEqual([
      "build",
      "--compile",
      "--minify",
      "./src/cli.ts",
      "--outfile",
      "dist/seri",
      "--define",
      "SERI_BAKED_HOSTED_ACCOUNTS=false",
      "--define",
      'SERI_BAKED_COMMIT="cafebabecafebabecafebabecafebabecafebabe"',
    ]);
  });

  test("always defines SERI_BAKED_HOSTED_ACCOUNTS=false when no commit is known", () => {
    const args = compileArgs({ entry: "./src/cli.ts", outfile: "dist/seri", platform: "darwin" });
    expect(args).toEqual([
      "build",
      "--compile",
      "--minify",
      "./src/cli.ts",
      "--outfile",
      "dist/seri",
      "--define",
      "SERI_BAKED_HOSTED_ACCOUNTS=false",
    ]);
    expect(args.filter((arg) => arg.startsWith("SERI_BAKED_COMMIT="))).toEqual([]);
  });

  test("forwards --target when set", () => {
    expect(
      compileArgs({
        entry: "./src/cli.ts",
        outfile: "dist/seri-linux-x64",
        target: "bun-linux-x64",
        commit: "abc",
        platform: "linux",
      }),
    ).toContain("bun-linux-x64");
  });

  test("defines OPENTUI_LIBC glibc for bun-linux-x64", () => {
    expect(
      compileArgs({
        entry: "./src/cli.ts",
        outfile: "dist/seri-linux-x64",
        target: "bun-linux-x64",
        platform: "darwin",
      }),
    ).toEqual([
      "build",
      "--compile",
      "--minify",
      "./src/cli.ts",
      "--outfile",
      "dist/seri-linux-x64",
      "--target",
      "bun-linux-x64",
      "--define",
      "SERI_BAKED_HOSTED_ACCOUNTS=false",
      "--define",
      'process.env.OPENTUI_LIBC="glibc"',
    ]);
  });

  test("defines OPENTUI_LIBC musl for bun-linux-x64-musl", () => {
    expect(
      compileArgs({
        entry: "./src/cli.ts",
        outfile: "dist/seri-linux-x64-musl",
        target: "bun-linux-x64-musl",
        platform: "linux",
      }),
    ).toEqual([
      "build",
      "--compile",
      "--minify",
      "./src/cli.ts",
      "--outfile",
      "dist/seri-linux-x64-musl",
      "--target",
      "bun-linux-x64-musl",
      "--define",
      "SERI_BAKED_HOSTED_ACCOUNTS=false",
      "--define",
      'process.env.OPENTUI_LIBC="musl"',
    ]);
  });

  test("defines OPENTUI_LIBC glibc for bun-linux-arm64", () => {
    expect(
      compileArgs({
        entry: "./src/cli.ts",
        outfile: "dist/seri-linux-arm64",
        target: "bun-linux-arm64",
        platform: "darwin",
      }),
    ).toEqual([
      "build",
      "--compile",
      "--minify",
      "./src/cli.ts",
      "--outfile",
      "dist/seri-linux-arm64",
      "--target",
      "bun-linux-arm64",
      "--define",
      "SERI_BAKED_HOSTED_ACCOUNTS=false",
      "--define",
      'process.env.OPENTUI_LIBC="glibc"',
    ]);
  });

  test("omits OPENTUI_LIBC for bun-darwin-arm64 even on a linux host", () => {
    expect(
      compileArgs({
        entry: "./src/cli.ts",
        outfile: "dist/seri-darwin-arm64",
        target: "bun-darwin-arm64",
        platform: "linux",
      }),
    ).toEqual([
      "build",
      "--compile",
      "--minify",
      "./src/cli.ts",
      "--outfile",
      "dist/seri-darwin-arm64",
      "--target",
      "bun-darwin-arm64",
      "--define",
      "SERI_BAKED_HOSTED_ACCOUNTS=false",
    ]);
  });

  test("defines OPENTUI_LIBC glibc when target is omitted on linux", () => {
    expect(
      compileArgs({
        entry: "./src/cli.ts",
        outfile: "dist/seri",
        platform: "linux",
      }),
    ).toEqual([
      "build",
      "--compile",
      "--minify",
      "./src/cli.ts",
      "--outfile",
      "dist/seri",
      "--define",
      "SERI_BAKED_HOSTED_ACCOUNTS=false",
      "--define",
      'process.env.OPENTUI_LIBC="glibc"',
    ]);
  });

  test("omits OPENTUI_LIBC when target is omitted on darwin", () => {
    expect(
      compileArgs({
        entry: "./src/cli.ts",
        outfile: "dist/seri",
        platform: "darwin",
      }),
    ).toEqual([
      "build",
      "--compile",
      "--minify",
      "./src/cli.ts",
      "--outfile",
      "dist/seri",
      "--define",
      "SERI_BAKED_HOSTED_ACCOUNTS=false",
    ]);
  });

  test("omits OPENTUI_LIBC for bun-windows-x64", () => {
    expect(
      compileArgs({
        entry: "./src/cli.ts",
        outfile: "dist/seri-windows-x64",
        target: "bun-windows-x64",
        platform: "linux",
      }),
    ).toEqual([
      "build",
      "--compile",
      "--minify",
      "./src/cli.ts",
      "--outfile",
      "dist/seri-windows-x64",
      "--target",
      "bun-windows-x64",
      "--define",
      "SERI_BAKED_HOSTED_ACCOUNTS=false",
    ]);
  });
});

describe("linuxOpentuiNativePackage", () => {
  test("names the glibc x64 package for bun-linux-x64", () => {
    expect(linuxOpentuiNativePackage("bun-linux-x64", "darwin", "arm64")).toBe(
      "@opentui/core-linux-x64",
    );
  });

  test("names the musl x64 package for bun-linux-x64-musl", () => {
    expect(linuxOpentuiNativePackage("bun-linux-x64-musl", "linux", "x64")).toBe(
      "@opentui/core-linux-x64-musl",
    );
  });

  test("names the glibc arm64 package for bun-linux-arm64", () => {
    expect(linuxOpentuiNativePackage("bun-linux-arm64", "darwin", "x64")).toBe(
      "@opentui/core-linux-arm64",
    );
  });

  test("omits a package for bun-darwin-arm64 even on a linux host", () => {
    expect(linuxOpentuiNativePackage("bun-darwin-arm64", "linux", "x64")).toBeUndefined();
  });

  test("names the host-arch glibc package when target is omitted on linux", () => {
    expect(linuxOpentuiNativePackage(undefined, "linux", "x64")).toBe("@opentui/core-linux-x64");
    expect(linuxOpentuiNativePackage(undefined, "linux", "arm64")).toBe(
      "@opentui/core-linux-arm64",
    );
  });

  test("omits a package when target is omitted on darwin", () => {
    expect(linuxOpentuiNativePackage(undefined, "darwin", "arm64")).toBeUndefined();
  });

  test("omits a package for bun-windows-x64", () => {
    expect(linuxOpentuiNativePackage("bun-windows-x64", "linux", "x64")).toBeUndefined();
  });
});

describe("stripPackedLinuxOpentuiNative", () => {
  test("does not strip a darwin target", () => {
    const stripped: string[] = [];
    stripPackedLinuxOpentuiNative(
      { target: "bun-darwin-arm64", platform: "linux", arch: "x64" },
      () => "/tmp/libopentui.so",
      (soPath) => {
        stripped.push(soPath);
      },
    );
    expect(stripped).toEqual([]);
  });

  test("strips the glibc x64 native for bun-linux-x64", () => {
    const resolved: string[] = [];
    const stripped: string[] = [];
    stripPackedLinuxOpentuiNative(
      { target: "bun-linux-x64", platform: "darwin", arch: "arm64" },
      (packageName) => {
        resolved.push(packageName);
        return "/tmp/glibc.so";
      },
      (soPath) => {
        stripped.push(soPath);
      },
    );
    expect(resolved).toEqual(["@opentui/core-linux-x64"]);
    expect(stripped).toEqual(["/tmp/glibc.so"]);
  });

  test("skips strip when the native file is missing", () => {
    const stripped: string[] = [];
    stripPackedLinuxOpentuiNative(
      { target: "bun-linux-x64", platform: "linux", arch: "x64" },
      () => undefined,
      (soPath) => {
        stripped.push(soPath);
        throw new Error("should not strip a missing native");
      },
    );
    expect(stripped).toEqual([]);
  });

  test("throws when strip fails", () => {
    expect(() =>
      stripPackedLinuxOpentuiNative(
        { target: "bun-linux-x64", platform: "linux", arch: "x64" },
        () => "/tmp/glibc.so",
        () => {
          throw new Error("strip failed");
        },
      ),
    ).toThrow("strip failed");
  });
});

function installedGlibcOpentuiSo(): string | undefined {
  try {
    const req = createRequire(import.meta.resolve("@opentui/core"));
    const so = join(dirname(req.resolve("@opentui/core-linux-x64/package.json")), "libopentui.so");
    return existsSync(so) ? so : undefined;
  } catch {
    return undefined;
  }
}

const stripAvailable = spawnSync("strip", ["--version"], { encoding: "utf8" }).status === 0;
const glibcSo = installedGlibcOpentuiSo();

describe.skipIf(process.platform !== "linux" || !stripAvailable || glibcSo === undefined)(
  "stripPackedLinuxOpentuiNative real strip",
  () => {
    test("strip -s drops DWARF from a copy of the glibc native", () => {
      const src = glibcSo;
      if (src === undefined) {
        throw new Error("glibc libopentui.so should be installed on linux");
      }
      const installedSize = statSync(src).size;
      const dir = mkdtempSync(join(tmpdir(), "seri-opentui-strip-"));
      try {
        const dest = join(dir, "libopentui.so");
        copyFileSync(src, dest);
        stripPackedLinuxOpentuiNative(
          { target: "bun-linux-x64", platform: "linux", arch: "x64" },
          () => dest,
        );
        const after = statSync(dest).size;
        expect(after).toBeLessThan(8_000_000);
        const desc = execFileSync("file", ["-b", dest], { encoding: "utf8" });
        expect(desc).toContain("stripped");
        expect(desc).not.toContain("debug_info");
        expect(statSync(src).size).toBe(installedSize);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
