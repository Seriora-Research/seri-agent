import { describe, expect, test } from "bun:test";
import {
  applyCompletion,
  type CompletionSource,
  resolveCompletion,
} from "../../src/tui/util/completion";

const commands: CompletionSource = {
  id: "commands",
  trigger: "/",
  lineStartOnly: true,
  items: [
    { value: "/perf-review", description: "Audit the repo for performance problems." },
    { value: "/permissions", description: "View or revoke approved tools." },
    { value: "/mode", description: "Cycle the permission mode." },
  ],
};

const files: CompletionSource = {
  id: "files",
  trigger: "@",
  items: [
    { value: "@src/cli.ts", description: "1200 lines" },
    { value: "@src/loop/loop.ts", description: "900 lines" },
  ],
};

const sources = [commands, files];

describe("resolveCompletion", () => {
  test("an empty value opens nothing", () => {
    expect(resolveCompletion(sources, "")).toBeUndefined();
  });

  test("a plain task opens nothing", () => {
    expect(resolveCompletion(sources, "fix the login bug")).toBeUndefined();
  });

  test("a leading slash offers every command, prefix matches first", () => {
    const completion = resolveCompletion(sources, "/per");
    expect(completion?.source.id).toBe("commands");
    expect(completion?.matches.map((m) => m.value)).toEqual(["/perf-review", "/permissions"]);
  });

  test("a name with no match closes the popup rather than showing an empty list", () => {
    expect(resolveCompletion(sources, "/zzzz")).toBeUndefined();
  });

  test("a trailing space ends completion", () => {
    expect(resolveCompletion(sources, "/perf-review ")).toBeUndefined();
  });

  // The caret token must start with / so deleting lineStartOnly cannot still pass on src/cli.ts.
  test("a token starting with a slash mid-line is a path, not a trigger", () => {
    expect(resolveCompletion(sources, "cd /perf")).toBeUndefined();
    expect(resolveCompletion(sources, "ls /mode")).toBeUndefined();
  });

  test("a slash inside a word is not a trigger either", () => {
    expect(resolveCompletion(sources, "look at src/cli.ts")).toBeUndefined();
    expect(resolveCompletion(sources, "read src/")).toBeUndefined();
  });

  test("a source without lineStartOnly fires on the token at the caret, mid-sentence", () => {
    const completion = resolveCompletion(sources, "please read @src/l");
    expect(completion?.source.id).toBe("files");
    expect(completion?.matches.map((m) => m.value)).toEqual(["@src/loop/loop.ts"]);
    expect(completion?.tokenStart).toBe("please read ".length);
  });

  test("substring matches come after prefix matches", () => {
    const completion = resolveCompletion(sources, "/review");
    expect(completion?.matches.map((m) => m.value)).toEqual(["/perf-review"]);
  });

  test("a bare trigger offers everything that source has", () => {
    expect(resolveCompletion(sources, "/")?.matches).toHaveLength(3);
  });
});

describe("applyCompletion", () => {
  test("replaces the whole token and adds the space that ends completion", () => {
    const completion = resolveCompletion(sources, "/per");
    const next = applyCompletion("/per", completion as never, {
      value: "/perf-review",
      description: "",
    });
    expect(next).toBe("/perf-review ");
    expect(resolveCompletion(sources, next)).toBeUndefined();
  });

  test("replaces only the token at the caret, leaving the text before it alone", () => {
    const value = "please read @src/l";
    const completion = resolveCompletion(sources, value);
    expect(
      applyCompletion(value, completion as never, {
        value: "@src/loop/loop.ts",
        description: "",
      }),
    ).toBe("please read @src/loop/loop.ts ");
  });
});
