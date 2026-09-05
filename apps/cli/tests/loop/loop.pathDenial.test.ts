import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { runLoop } from "../../src/loop/loop";
import { createToolDefinitions } from "../../src/provider/tools";
import {
  baseMessages,
  collect,
  streamResult,
  textOnlyChunks,
  toolCallChunks,
} from "./fixtures";

let tmpDir: string;
let missing: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "seri-path-denial-"));
  missing = join(tmpDir, "does-not-exist");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function oneCallThenText(toolName: string, input: unknown) {
  return new MockLanguageModelV4({
    doStream: [
      streamResult(toolCallChunks("call-1", toolName, input)),
      streamResult(textOnlyChunks("Done")),
    ],
  });
}

function errorText(events: Awaited<ReturnType<typeof collect>>): string {
  const error = events.find((event) => event.type === "error");
  return error?.type === "error" ? error.error : "";
}

describe("runLoop path denials", () => {
  for (const toolName of ["glob", "grep", "read_file"] as const) {
    test(`a deny rule on a missing ${toolName} path is a permission denial, not a missing-path probe`, async () => {
      const input =
        toolName === "read_file"
          ? { path: missing }
          : toolName === "glob"
            ? { pattern: "*.txt", path: missing }
            : { pattern: "secret", path: missing };
      const events = await collect(
        runLoop({
          model: oneCallThenText(toolName, input),
          tools: createToolDefinitions(tmpDir),
          messages: baseMessages,
          permissionMode: "auto",
          pathDenials: [{ tool: toolName, pattern: `${tmpDir.replaceAll("\\", "/")}/**` }],
        }),
      );

      expect(events).toContainEqual({
        type: "permission-denied",
        name: toolName,
        reason: "blocked",
      });
      expect(errorText(events)).not.toContain("Path not found");
      expect(errorText(events)).not.toContain("ENOENT");
    });
  }

  test("a missing glob path without a deny rule is still reported as missing, not as a denial", async () => {
    const events = await collect(
      runLoop({
        model: oneCallThenText("glob", { pattern: "*.txt", path: missing }),
        tools: createToolDefinitions(tmpDir),
        messages: baseMessages,
        permissionMode: "auto",
      }),
    );

    expect(events.find((event) => event.type === "permission-denied")).toBeUndefined();
    expect(errorText(events)).toContain(`Path not found: ${missing}`);
  });
});
