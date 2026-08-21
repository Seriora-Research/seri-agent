import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionOptions } from "ai";
import type { MutationContext } from "../../src/checkpoint/wrapTools";
import { DISPATCH_TOOL_NAME, toolDefinitions } from "../../src/provider/tools";
import {
  buildRoleToolSet,
  DISPATCHABLE_ROLES,
  roleAddendum,
  roleMutatesFilesystem,
} from "../../src/subagents/roles";

function execOpts(): ToolExecutionOptions<Record<string, unknown>> {
  return { toolCallId: "c1", messages: [], context: {} };
}

describe("buildRoleToolSet", () => {
  test("explore and plan are both exactly read_file/grep/glob, and identical to each other", () => {
    const explore = buildRoleToolSet("explore");
    const plan = buildRoleToolSet("plan");
    expect(Object.keys(explore).sort()).toEqual(["glob", "grep", "read_file"]);
    expect(Object.keys(plan).sort()).toEqual(["glob", "grep", "read_file"]);
  });

  test("test adds bash/powershell to the read-only set and has no write_file/edit", () => {
    const tools = buildRoleToolSet("test");
    expect(Object.keys(tools).sort()).toEqual(["bash", "glob", "grep", "powershell", "read_file"]);
    expect(tools.write_file).toBeUndefined();
    expect(tools.edit).toBeUndefined();
  });

  test("code has every key of toolDefinitions", () => {
    const tools = buildRoleToolSet("code");
    expect(Object.keys(tools).sort()).toEqual(Object.keys(toolDefinitions).sort());
  });

  test("recursion guard: no role's ToolSet contains dispatch_subagents", () => {
    for (const role of DISPATCHABLE_ROLES) {
      expect(Object.keys(buildRoleToolSet(role))).not.toContain(DISPATCH_TOOL_NAME);
    }
  });

  test("each tool definition is the same object reference as toolDefinitions', not wrapped when no onAfterMutation is given", () => {
    const tools = buildRoleToolSet("code");
    for (const [name, definition] of Object.entries(tools)) {
      expect(definition).toBe(toolDefinitions[name as keyof typeof toolDefinitions]);
    }
  });

  // Round-trip regression for the write-ledger gap: a `code` subagent's write_file was never
  // wrapped with anything at all, so its writes were never recorded (writeLedger.ts's recordWrite)
  // and a later /undo could never prove one of its files safe to delete — see wrapTools.ts's
  // withMutationRecording for the full mechanism this closes.
  test("write_file is recorded via onAfterMutation when one is provided, with no other tool wrapped", async () => {
    const calls: MutationContext[] = [];
    const tools = buildRoleToolSet("code", (context) => calls.push(context));

    expect(tools.read_file).toBe(toolDefinitions.read_file);
    expect(tools.write_file).not.toBe(toolDefinitions.write_file);

    const root = mkdtempSync(join(tmpdir(), "seri-role-tools-test-"));
    const path = join(root, "a.txt");
    try {
      await tools.write_file?.execute?.({ path, content: "hello" }, execOpts());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.tool).toBe("write_file");
    expect((calls[0]?.args as { path: string }).path).toBe(path);
  });
});

describe("roleAddendum", () => {
  test("names each role's own tools and says the role cannot dispatch subagents", () => {
    for (const role of DISPATCHABLE_ROLES) {
      const text = roleAddendum(role);
      expect(text).toContain("cannot dispatch subagents");
      for (const name of Object.keys(buildRoleToolSet(role))) {
        expect(text).toContain(name);
      }
    }
  });

  test("plan is never told to write; test is never told to fix", () => {
    expect(roleAddendum("plan")).toMatch(/cannot write/i);
    expect(roleAddendum("test")).toMatch(/cannot fix/i);
  });
});

describe("roleMutatesFilesystem", () => {
  // The predicate dispatch.ts keys both its pre-dispatch checkpoint and its writer-serialization
  // on: explore/plan hold no tool in FS_MUTATING_TOOL_NAMES, code/test both do (test via
  // bash/powershell, not write_file) and must be treated the same way as a result.
  test("explore and plan do not mutate the filesystem", () => {
    expect(roleMutatesFilesystem("explore")).toBe(false);
    expect(roleMutatesFilesystem("plan")).toBe(false);
  });

  test("code and test both mutate the filesystem", () => {
    expect(roleMutatesFilesystem("code")).toBe(true);
    expect(roleMutatesFilesystem("test")).toBe(true);
  });
});
