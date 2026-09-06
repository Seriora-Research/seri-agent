import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  FILE_CHANGE_LINE_CAP,
  FILE_CHANGE_LINE_CHAR_CAP,
  buildFileChange,
  fileChangeFromTool,
  fileChangePlainText,
  isFileChangeView,
} from "../src/fileChange";

describe("buildFileChange", () => {
  test("a replacement is red then green with two lines of context", () => {
    const view = buildFileChange("Edit", "keep\nold\nkeep2\n", "keep\nnew\nkeep2\n");
    expect(view.kind).toBe("update");
    expect(view.added).toBe(1);
    expect(view.removed).toBe(1);
    expect(view.hidden).toBe(0);
    expect(view.lines.map((line) => line.kind)).toEqual([
      "context",
      "del",
      "add",
      "context",
      "context",
    ]);
    expect(view.lines.map((line) => line.text)).toEqual([
      "  keep",
      "- old",
      "+ new",
      "  keep2",
      "  ",
    ]);
  });

  test("a create is all adds", () => {
    const view = buildFileChange("Write a.ts", "", "one\ntwo");
    expect(view.kind).toBe("create");
    expect(view.removed).toBe(0);
    expect(view.added).toBe(2);
    expect(view.lines.every((line) => line.kind === "add")).toBe(true);
  });

  test("a delete-only change is all dels", () => {
    const view = buildFileChange("Write a.ts", "gone", "");
    expect(view.removed).toBe(1);
    expect(view.added).toBe(0);
    expect(view.lines.some((line) => line.kind === "del")).toBe(true);
    expect(view.lines.some((line) => line.kind === "add")).toBe(false);
  });

  test("an empty change has counts and no body", () => {
    const view = buildFileChange("Write a.ts", "same\n", "same\n");
    expect(view.added).toBe(0);
    expect(view.removed).toBe(0);
    expect(view.lines).toEqual([]);
    expect(view.hidden).toBe(0);
    expect(fileChangePlainText(view)).toBe("Write a.ts  +0 −0");
  });

  test("multiline replacement keeps surrounding context", () => {
    const view = buildFileChange("Edit", "a\nb\nc\nd\ne\n", "a\nb\nC\nd\ne\n");
    expect(view.added).toBe(1);
    expect(view.removed).toBe(1);
    expect(view.lines.map((line) => line.text)).toEqual([
      "  a",
      "  b",
      "- c",
      "+ C",
      "  d",
      "  e",
    ]);
  });

  test("truncation keeps +/− counts and still shows some adds", () => {
    const before = Array.from({ length: 40 }, (_, i) => `old${i}`).join("\n");
    const after = Array.from({ length: 40 }, (_, i) => `new${i}`).join("\n");
    const view = buildFileChange("Write big.ts", before, after);
    expect(view.lines).toHaveLength(FILE_CHANGE_LINE_CAP);
    expect(view.added).toBe(40);
    expect(view.removed).toBe(40);
    expect(view.hidden).toBe(80 - FILE_CHANGE_LINE_CAP);
    expect(view.lines.some((line) => line.kind === "del")).toBe(true);
    expect(view.lines.some((line) => line.kind === "add")).toBe(true);
    expect(fileChangePlainText(view)).toContain(`+${view.added} −${view.removed}`);
    expect(fileChangePlainText(view)).toContain(`… ${view.hidden} more`);
  });

  test("maxLines caps the body without changing +/− counts", () => {
    const before = Array.from({ length: 20 }, (_, i) => `old${i}`).join("\n");
    const after = Array.from({ length: 20 }, (_, i) => `new${i}`).join("\n");
    const view = buildFileChange("Write big.ts", before, after, { maxLines: 4 });
    expect(view.lines).toHaveLength(4);
    expect(view.added).toBe(20);
    expect(view.removed).toBe(20);
    expect(view.lines.some((line) => line.kind === "add")).toBe(true);
    expect(view.lines.some((line) => line.kind === "del")).toBe(true);
  });

  test("a long line is capped without changing the line count", () => {
    const view = buildFileChange("Edit", "short", "x".repeat(FILE_CHANGE_LINE_CHAR_CAP + 20));
    expect(view.lines).toHaveLength(2);
    const added = view.lines.find((line) => line.kind === "add");
    expect(added?.text.length).toBe(FILE_CHANGE_LINE_CHAR_CAP);
    expect(added?.text.endsWith("…")).toBe(true);
  });

  test("CRLF before-image diffs against LF after-image without leftover CR", () => {
    const view = buildFileChange("Write a.ts", "a\r\nb\r\n", "a\nB\n");
    expect(view.lines.some((line) => line.text.includes("\r"))).toBe(false);
    expect(view.removed).toBe(1);
    expect(view.added).toBe(1);
  });
});

describe("fileChangeFromTool", () => {
  test("edit diffs the full content against the returned body", () => {
    const view = fileChangeFromTool(
      "edit",
      { content: "keep\nold\nkeep2\n", oldString: "old", newString: "new" },
      "keep\nnew\nkeep2\n",
    );
    expect(view?.title).toBe("Edit");
    expect(view?.lines.map((line) => line.text)).toEqual([
      "  keep",
      "- old",
      "+ new",
      "  keep2",
      "  ",
    ]);
  });

  test("edit without a string result falls back to oldString/newString", () => {
    const view = fileChangeFromTool(
      "edit",
      { oldString: "old", newString: "new" },
      { written: true },
    );
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

  test("write_file without a change still builds from previous + content", () => {
    const view = fileChangeFromTool(
      "write_file",
      { path: "a.txt", content: "new" },
      { written: true, previous: "old" },
    );
    expect(view?.title).toBe("Write a.txt");
    expect(view?.lines.map((line) => line.text)).toEqual(["- old", "+ new"]);
  });

  test("write_file without content in args and without a change produces nothing", () => {
    expect(fileChangeFromTool("write_file", { path: "a.txt" }, { written: true })).toBeUndefined();
  });

  test("negative control: omit newString and edit produces nothing", () => {
    expect(fileChangeFromTool("edit", { oldString: "old" }, { written: true })).toBeUndefined();
  });

  test("write_file title uses basename for a nested path", () => {
    const view = fileChangeFromTool(
      "write_file",
      { path: join("src", "pkg", "a.ts"), content: "x" },
      { previous: null },
    );
    expect(view?.title).toBe("Write a.ts");
    expect(view?.kind).toBe("create");
  });

  test("isFileChangeView rejects a payload without kind", () => {
    expect(
      isFileChangeView({
        title: "Write a.ts",
        added: 1,
        removed: 0,
        hidden: 0,
        lines: [{ kind: "add", text: "+ x" }],
      }),
    ).toBe(false);
  });
});
