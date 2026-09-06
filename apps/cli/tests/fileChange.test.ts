import { describe, expect, test } from "bun:test";
import {
  FILE_CHANGE_LINE_CAP,
  buildFileChange,
  fileChangeFromTool,
  fileChangePlainText,
} from "../src/fileChange";

describe("buildFileChange", () => {
  test("a replacement is red then green with two lines of context", () => {
    const view = buildFileChange("Edit", "keep\nold\nkeep2", "keep\nnew\nkeep2");
    expect(view.added).toBe(1);
    expect(view.removed).toBe(1);
    expect(view.hidden).toBe(0);
    expect(view.lines.map((line) => line.kind)).toEqual(["context", "del", "add", "context"]);
    expect(view.lines.map((line) => line.text)).toEqual(["  keep", "- old", "+ new", "  keep2"]);
  });

  test("a create is all adds", () => {
    const view = buildFileChange("Write a.ts", "", "one\ntwo");
    expect(view.removed).toBe(0);
    expect(view.added).toBe(2);
    expect(view.lines.every((line) => line.kind === "add")).toBe(true);
  });

  test("truncation keeps +/− counts and reports hidden lines", () => {
    const before = Array.from({ length: 40 }, (_, i) => `old${i}`).join("\n");
    const after = Array.from({ length: 40 }, (_, i) => `new${i}`).join("\n");
    const view = buildFileChange("Write big.ts", before, after);
    expect(view.lines).toHaveLength(FILE_CHANGE_LINE_CAP);
    expect(view.added).toBe(40);
    expect(view.removed).toBe(40);
    expect(view.hidden).toBe(80 - FILE_CHANGE_LINE_CAP);
    expect(fileChangePlainText(view)).toContain(`… ${view.hidden} more`);
  });

  test("CRLF before-image diffs against LF after-image without leftover CR", () => {
    const view = buildFileChange("Write a.ts", "a\r\nb\r\n", "a\nB\n");
    expect(view.lines.some((line) => line.text.includes("\r"))).toBe(false);
    expect(view.removed).toBe(1);
    expect(view.added).toBe(1);
  });
});

describe("fileChangeFromTool", () => {
  test("edit uses oldString/newString from args, ignoring the returned body", () => {
    const view = fileChangeFromTool(
      "edit",
      { content: "keep\nold\n", oldString: "old", newString: "new" },
      "keep\nnew\n",
    );
    expect(view?.title).toBe("Edit");
    expect(view?.lines.map((line) => line.text)).toEqual(["- old", "+ new"]);
  });

  test("write_file prefers a capped change on the result over a full previous", () => {
    const change = buildFileChange("Write a.ts", "old", "new");
    const view = fileChangeFromTool(
      "write_file",
      { path: "apps/cli/a.ts", content: "new" },
      { written: true, previous: "this must not leak", change },
    );
    expect(view).toEqual(change);
    expect(JSON.stringify(view)).not.toContain("this must not leak");
  });

  test("write_file without content in args produces nothing", () => {
    expect(fileChangeFromTool("write_file", { path: "a.txt" }, { written: true })).toBeUndefined();
  });

  test("negative control: omit newString and edit produces nothing", () => {
    expect(fileChangeFromTool("edit", { oldString: "old" }, "x")).toBeUndefined();
  });
});
