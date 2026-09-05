import { describe, expect, test } from "bun:test";
import { foldsCase } from "../../src/caseFold";
import { classifyBuiltin, WRITE_TOOL_NAMES } from "../../src/provider/tools";
import { TODO_TOOL_NAME } from "../../src/todo/tool";
import { checkPermission, cycleMode, type PermissionMode } from "../../src/gate/gate";

const READ_TOOL_NAMES = ["read_file", "grep", "glob"];

// A name no classifier has ever seen, shaped the way an MCP server's would be (mcp_<server>_<tool>).
const UNKNOWN_TOOL_NAME = "mcp_exa_web_search";

test("the gate's write class over the built-ins is exactly WRITE_TOOL_NAMES", () => {
  const write = [...WRITE_TOOL_NAMES, ...READ_TOOL_NAMES].filter(
    (name) => classifyBuiltin(name) === "write",
  );
  expect(new Set(write)).toEqual(new Set<string>(WRITE_TOOL_NAMES));
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
    test("allows todo", () => {
      expect(checkPermission(TODO_TOOL_NAME, "read-only")).toBe("allow");
    });
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

  // The inversion, asserted where it bites: a name the gate has never heard of is not "safe by
  // absence" any more, it takes the same path bash does in all three modes.
  describe("an unrecognised tool name", () => {
    test("is blocked in read-only", () => {
      expect(checkPermission(UNKNOWN_TOOL_NAME, "read-only")).toBe("block");
    });

    test("needs approval in approve-each", () => {
      expect(checkPermission(UNKNOWN_TOOL_NAME, "approve-each")).toBe("needs-approval");
    });

    test("is allowed in auto", () => {
      expect(checkPermission(UNKNOWN_TOOL_NAME, "auto")).toBe("allow");
    });

    test("is allowed in approve-each once granted", () => {
      const allowed = new Set([UNKNOWN_TOOL_NAME]);
      expect(checkPermission(UNKNOWN_TOOL_NAME, "approve-each", allowed)).toBe("allow");
    });
  });

  // The seam a caller composing a non-built-in tool set uses; the default is only a default.
  describe("a caller-supplied classify", () => {
    test("decides in both directions, overriding the built-in classification", () => {
      expect(checkPermission("bash", "read-only", undefined, () => "read")).toBe("allow");
      expect(checkPermission("read_file", "read-only", undefined, () => "write")).toBe("block");
    });
  });

  describe("path denials", () => {
    const missing = "/tmp/seri-does-not-exist/secret.txt";
    const denials = [{ tool: "read_file", pattern: "/tmp/seri-does-not-exist/**" }];

    test("a deny rule blocks a missing path in every mode, before the read short-circuit", () => {
      for (const mode of ["read-only", "approve-each", "auto"] as const) {
        expect(
          checkPermission("read_file", mode, undefined, undefined, {
            input: { path: missing },
            denials,
          }),
        ).toBe("block");
      }
    });

    test("a deny rule for glob or grep blocks a missing search path", () => {
      expect(
        checkPermission("glob", "auto", undefined, undefined, {
          input: { path: missing, pattern: "*.txt" },
          denials: [{ tool: "glob", pattern: "/tmp/seri-does-not-exist/**" }],
        }),
      ).toBe("block");
      expect(
        checkPermission("grep", "auto", undefined, undefined, {
          input: { path: missing, pattern: "secret" },
          denials: [{ tool: "grep", pattern: "/tmp/seri-does-not-exist/**" }],
        }),
      ).toBe("block");
    });

    test("a deny for one tool does not block another tool on the same path", () => {
      expect(
        checkPermission("glob", "auto", undefined, undefined, {
          input: { path: missing, pattern: "*.txt" },
          denials,
        }),
      ).toBe("allow");
    });

    test("a path that does not match the pattern is still allowed", () => {
      expect(
        checkPermission("read_file", "auto", undefined, undefined, {
          input: { path: "/tmp/other/file.txt" },
          denials,
        }),
      ).toBe("allow");
    });

    test("a trailing /** pattern also blocks the directory itself", () => {
      expect(
        checkPermission("glob", "auto", undefined, undefined, {
          input: { path: "/tmp/seri-does-not-exist", pattern: "*.txt" },
          denials: [{ tool: "glob", pattern: "/tmp/seri-does-not-exist/**" }],
        }),
      ).toBe("block");
    });

    test("the template .env rule matches ./, absolute, and .. spellings of the same file", () => {
      const cwd = "/tmp/seri-project";
      const denials = [{ tool: "read_file", pattern: ".env" }];
      const check = (path: string) =>
        checkPermission("read_file", "auto", undefined, undefined, {
          input: { path },
          denials,
          cwd,
        });
      expect(check(".env")).toBe("block");
      expect(check("./.env")).toBe("block");
      expect(check("/tmp/seri-project/.env")).toBe("block");
      expect(check("subdir/../.env")).toBe("block");
      expect(check("other.env")).toBe("allow");
    });

    test("a glob deny matches a .. spelling that resolves onto the denied tree", () => {
      const denials = [{ tool: "glob", pattern: "/tmp/secret/**" }];
      expect(
        checkPermission("glob", "auto", undefined, undefined, {
          input: { path: "/tmp/other/../secret/missing", pattern: "*.txt" },
          denials,
          cwd: "/tmp/app",
        }),
      ).toBe("block");
      expect(
        checkPermission("glob", "auto", undefined, undefined, {
          input: { path: "../secret/missing", pattern: "*.txt" },
          denials,
          cwd: "/tmp/app",
        }),
      ).toBe("block");
    });

    (foldsCase() ? test : test.skip)(
      "a deny matches a case-folded spelling of the same path",
      () => {
        expect(
          checkPermission("read_file", "auto", undefined, undefined, {
            input: { path: "/tmp/Secret/missing" },
            denials: [{ tool: "read_file", pattern: "/tmp/secret/**" }],
            cwd: "/tmp",
          }),
        ).toBe("block");
      },
    );
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
