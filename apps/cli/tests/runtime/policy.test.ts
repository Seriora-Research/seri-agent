import { describe, expect, test } from "bun:test";
import type { RunPolicy } from "../../src/runtime/types";
import { READ_ONLY_TOOL_NAMES } from "../../src/provider/tools";

describe("RunPolicy", () => {
  test("scheduled policy is read-only with an empty grant list", () => {
    const scheduled: RunPolicy = {
      origin: "scheduled",
      permissionMode: "read-only",
      allowedTools: [],
    };
    expect(scheduled.origin).toBe("scheduled");
    expect(scheduled.permissionMode).toBe("read-only");
    expect(scheduled.allowedTools).toEqual([]);
    expect(scheduled).not.toHaveProperty("approvalPrompt");
  });

  test("attended policy can carry grants and an approval prompt", () => {
    const attended: RunPolicy = {
      origin: "attended",
      permissionMode: "approve-each",
      allowedTools: ["write_file"],
      approvalPrompt: async () => "no",
    };
    expect(attended.origin).toBe("attended");
    expect(attended.allowedTools).toContain("write_file");
  });

  test("read-only tool names are exactly the scheduled surface", () => {
    expect([...READ_ONLY_TOOL_NAMES].sort()).toEqual(["glob", "grep", "read_file"]);
  });
});

// Compile-time fixtures: these assignments must fail to typecheck if the union is widened.
const _scheduledOk: RunPolicy = {
  origin: "scheduled",
  permissionMode: "read-only",
  allowedTools: [],
};

const _attendedOk: RunPolicy = {
  origin: "attended",
  permissionMode: "auto",
  allowedTools: ["bash"],
};

// @ts-expect-error scheduled runs cannot carry an approval prompt
const _scheduledApproval: RunPolicy = {
  origin: "scheduled",
  permissionMode: "read-only",
  allowedTools: [],
  approvalPrompt: async () => "yes",
};

// @ts-expect-error scheduled permission mode is only read-only
const _scheduledAuto: RunPolicy = {
  origin: "scheduled",
  permissionMode: "auto",
  allowedTools: [],
};

// @ts-expect-error scheduled grants must be the empty tuple
const _scheduledGrant: RunPolicy = {
  origin: "scheduled",
  permissionMode: "read-only",
  allowedTools: ["write_file"],
};

void _scheduledOk;
void _attendedOk;
void _scheduledApproval;
void _scheduledAuto;
void _scheduledGrant;
