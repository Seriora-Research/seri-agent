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
      }),
    ).toEqual([
      "build",
      "--compile",
      "./src/cli.ts",
      "--outfile",
      "dist/seri",
      "--define",
      'SERI_BAKED_COMMIT="cafebabecafebabecafebabecafebabecafebabe"',
    ]);
  });

  test("omits --define when no commit is known — the compiled-binary gap", () => {
    const args = compileArgs({ entry: "./src/cli.ts", outfile: "dist/seri" });
    expect(args).toEqual(["build", "--compile", "./src/cli.ts", "--outfile", "dist/seri"]);
    expect(args.join(" ")).not.toContain("--define");
  });

  test("forwards --target when set", () => {
    expect(
      compileArgs({
        entry: "./src/cli.ts",
        outfile: "dist/seri-linux-x64",
        target: "bun-linux-x64",
        commit: "abc",
      }),
    ).toContain("bun-linux-x64");
  });
});
