import { describe, expect, test } from "bun:test";
import { compileArgs, resolveBuildCommit } from "../../src/build/compile";

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
