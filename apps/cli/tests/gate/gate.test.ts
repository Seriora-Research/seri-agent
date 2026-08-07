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

  describe("allowedTools", () => {
    test("approve-each allows only the granted tool, not every write tool", () => {
      const allowed = new Set(["bash"]);
      expect(checkPermission("bash", "approve-each", allowed)).toBe("allow");
      for (const name of WRITE_TOOL_NAMES.filter((n) => n !== "bash")) {
        expect(checkPermission(name, "approve-each", allowed)).toBe("needs-approval");
      }
    });

    test("a grant does not survive a cycle to read-only", () => {
      expect(checkPermission("bash", "read-only", new Set(["bash"]))).toBe("block");
    });

    test("the allowlist does not widen or narrow auto", () => {
      for (const name of [...WRITE_TOOL_NAMES, ...READ_TOOL_NAMES]) {
        expect(checkPermission(name, "auto", new Set())).toBe("allow");
      }
    });

    test("the allowlist does not make a read tool need approval", () => {
      expect(checkPermission("read_file", "approve-each", new Set(["read_file"]))).toBe("allow");
    });
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
