import { describe, expect, test } from "bun:test";
import { approvalCopy, optionLabels, parentDirDisplay } from "../../src/tui/util/approvalCopy";

describe("parentDirDisplay", () => {
  test("two or fewer parents stay whole, with a trailing slash", () => {
    expect(parentDirDisplay("gate.ts")).toBe("");
    expect(parentDirDisplay("src/gate.ts")).toBe("src/");
    expect(parentDirDisplay("src/gate/gate.ts")).toBe("src/gate/");
  });

  test("deeper parents collapse to the last two segments", () => {
    expect(parentDirDisplay("apps/cli/src/gate/gate.ts")).toBe("…/src/gate/");
  });

  test("windows separators normalize", () => {
    expect(parentDirDisplay("apps\\cli\\src\\gate\\gate.ts")).toBe("…/src/gate/");
  });
});

describe("approvalCopy", () => {
  test("write_file is the basename plus a muted parent", () => {
    expect(approvalCopy("write_file", { path: "apps/cli/src/gate/gate.ts" })).toEqual({
      question: "Write gate.ts?",
      headline: "Write gate.ts",
      detail: "…/src/gate/",
    });
  });

  test("edit uses the same path shape with Edit", () => {
    expect(approvalCopy("edit", { path: "apps/cli/src/gate/gate.ts" })).toEqual({
      question: "Edit gate.ts?",
      headline: "Edit gate.ts",
      detail: "…/src/gate/",
    });
  });

  test("bash is the command, with no Always-adjacent JSON", () => {
    expect(approvalCopy("bash", { command: "bun test" })).toEqual({
      question: "Run bun test?",
      headline: "Run bun test",
      detail: "",
    });
  });

  test("an unknown tool falls back to Approve <name>", () => {
    expect(approvalCopy("mystery", {})).toEqual({
      question: "Approve mystery?",
      headline: "mystery",
      detail: "",
    });
  });

  test("shell omits Always; write offers it", () => {
    expect(optionLabels(true)).toEqual(["[y]es", "[a]lways", "[N]o"]);
    expect(optionLabels(false)).toEqual(["[y]es", "[N]o"]);
  });
});
