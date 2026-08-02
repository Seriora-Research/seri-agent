import { describe, expect, test } from "bun:test";
import { WRITE_TOOL_NAMES } from "../../src/provider/tools";
import { checkPermission, cycleMode, type PermissionMode, WRITE_TOOLS } from "../../src/gate/gate";

const READ_TOOL_NAMES = ["read_file", "grep", "glob"];

test("WRITE_TOOLS matches provider/tools.ts's WRITE_TOOL_NAMES exactly", () => {
  expect(WRITE_TOOLS).toEqual(new Set(WRITE_TOOL_NAMES));
});

describe("checkPermission", () => {
  describe("read-only", () => {
    for (const name of WRITE_TOOL_NAMES) {
      test(`blocks ${name}`, () => {
        expect(checkPermission(name, "read-only")).toBe("block");
      });
    }
    for (const name of READ_TOOL_NAMES) {
      test(`allows ${name}`, () => {
        expect(checkPermission(name, "read-only")).toBe("allow");
      });
    }
  });

  describe("approve-each", () => {
    for (const name of WRITE_TOOL_NAMES) {
      test(`needs approval for ${name}`, () => {
        expect(checkPermission(name, "approve-each")).toBe("needs-approval");
      });
    }
    for (const name of READ_TOOL_NAMES) {
      test(`allows ${name}`, () => {
        expect(checkPermission(name, "approve-each")).toBe("allow");
      });
    }
  });

  describe("auto", () => {
    for (const name of [...WRITE_TOOL_NAMES, ...READ_TOOL_NAMES]) {
      test(`allows ${name}`, () => {
        expect(checkPermission(name, "auto")).toBe("allow");
      });
    }
  });
});

describe("cycleMode", () => {
  test("cycles read-only -> approve-each -> auto -> read-only", () => {
    const sequence: PermissionMode[] = ["read-only"];
    for (let i = 0; i < 3; i++) {
      sequence.push(cycleMode(sequence[sequence.length - 1] as PermissionMode));
    }
    expect(sequence).toEqual(["read-only", "approve-each", "auto", "read-only"]);
  });
});
