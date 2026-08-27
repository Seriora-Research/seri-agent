import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { DispatchResult } from "../../src/subagents/dispatch";
import type { ProcessResult } from "../../src/tools/spawnCollect";
import {
  anomalyLineForDenial,
  anomalyLineForResult,
  detailLinesForResult,
  recordCall,
  recordDenial,
  recordResult,
  renderLiveToolActivity,
  renderToolActivity,
  summarizeArgs,
  type ToolActivityEntry,
  trimPath,
} from "../../src/tui/state/toolActivity";
import { TREE_BRANCH } from "../../src/tui/theme/theme";
import type { CheckOutcome } from "../../src/verify/outcome";

function proc(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    ...overrides,
  };
}

function dispatchResult(ran: number, total: number): DispatchResult {
  return {
    results: Array.from({ length: total }, (_, i) => ({
      role: "explore" as const,
      goal: "g",
      summary: "s",
      usage: {},
      toolCallsMade: 0,
      doneReason: i < ran ? ("no-tool-call" as const) : undefined,
    })),
    totalUsage: {},
  };
}

describe("trimPath", () => {
  test("an absolute path under cwd becomes relative", () => {
    const abs = join(process.cwd(), "apps/cli/src/tui/app.tsx");
    expect(trimPath(abs)).toBe(join("apps/cli/src/tui/app.tsx"));
  });

  test("an absolute path outside cwd is left unchanged", () => {
    expect(trimPath("/tmp/outside-seri.txt")).toBe("/tmp/outside-seri.txt");
  });

  test("a path that walks out of cwd via .. is left unchanged", () => {
    const outside = join(process.cwd(), "..", "outside-seri.txt");
    expect(trimPath(outside)).toBe(outside);
  });
});

describe("summarizeArgs", () => {
  test("read_file uses the trimmed path", () => {
    expect(summarizeArgs("read_file", { path: join(process.cwd(), "a.txt") })).toBe("Read a.txt");
  });

  test("write_file uses the trimmed path", () => {
    expect(summarizeArgs("write_file", { path: join(process.cwd(), "b.txt") })).toBe("Wrote b.txt");
  });

  test("edit has no path", () => {
    expect(summarizeArgs("edit", { content: "x", oldString: "a", newString: "b" })).toBe("Edited");
  });

  test("grep uses the pattern", () => {
    expect(summarizeArgs("grep", { pattern: "TODO", path: "/repo" })).toBe("Searched TODO");
  });

  test("glob uses the pattern", () => {
    expect(summarizeArgs("glob", { pattern: "**/*.ts", path: "/repo" })).toBe("Searched **/*.ts");
  });

  test("bash caps a long command at ~60 characters", () => {
    const command = "x".repeat(80);
    const line = summarizeArgs("bash", { command });
    expect(line.startsWith("Ran ")).toBe(true);
    expect(line.length).toBeLessThanOrEqual("Ran ".length + 60);
    expect(line.endsWith("…")).toBe(true);
  });

  test("powershell uses the same Ran verb", () => {
    expect(summarizeArgs("powershell", { command: "Get-ChildItem" })).toBe("Ran Get-ChildItem");
  });

  test("a control character in a bash command is escaped", () => {
    const line = summarizeArgs("bash", { command: "echo \x1b[31mhi" });
    expect(line.includes("\x1b")).toBe(false);
    expect(line).toContain("\\x1b");
  });

  test("a control character in a read_file path is escaped", () => {
    const line = summarizeArgs("read_file", { path: "a\x07.txt" });
    expect(line.includes("\x07")).toBe(false);
    expect(line).toContain("\\x07");
  });
});

describe("detailLinesForResult", () => {
  test("grep files_with_matches lists up to 3 trimmed paths", () => {
    const cwdFile = join(process.cwd(), "one.ts");
    expect(
      detailLinesForResult("grep", {
        mode: "files_with_matches",
        files: [cwdFile, "two.ts", "three.ts"],
        truncated: false,
      }),
    ).toEqual(["one.ts", "two.ts", "three.ts"]);
  });

  test("grep content mode reads match files", () => {
    expect(
      detailLinesForResult("grep", {
        mode: "content",
        matches: [
          { file: "a.ts", line: 1, text: "x" },
          { file: "b.ts", line: 2, text: "y" },
        ],
        truncated: false,
      }),
    ).toEqual(["a.ts", "b.ts"]);
  });

  test("grep count mode reads count files", () => {
    expect(
      detailLinesForResult("grep", {
        mode: "count",
        counts: [
          { file: "a.ts", count: 2 },
          { file: "b.ts", count: 1 },
        ],
        truncated: false,
      }),
    ).toEqual(["a.ts", "b.ts"]);
  });

  test("glob lists files and an overflow line when truncated", () => {
    expect(
      detailLinesForResult("glob", {
        files: ["a.ts", "b.ts", "c.ts", "d.ts"],
        truncated: true,
      }),
    ).toEqual(["a.ts", "b.ts", "c.ts", "…1 more"]);
  });

  test("truncated with exactly 3 paths still adds an overflow line", () => {
    expect(
      detailLinesForResult("glob", { files: ["a.ts", "b.ts", "c.ts"], truncated: true }),
    ).toEqual(["a.ts", "b.ts", "c.ts", "…more"]);
  });

  test("every other tool returns no detail lines", () => {
    expect(detailLinesForResult("read_file", "ok")).toEqual([]);
    expect(detailLinesForResult("bash", proc())).toEqual([]);
  });

  test("a control character in a glob path is escaped", () => {
    const lines = detailLinesForResult("glob", { files: ["a\x1b.ts"], truncated: false });
    expect(lines[0]?.includes("\x1b")).toBe(false);
    expect(lines[0]).toContain("\\x1b");
  });
});

describe("anomalyLineForResult", () => {
  test("a clean bash run is not an anomaly", () => {
    expect(anomalyLineForResult("bash", { command: "true" }, proc())).toBeUndefined();
  });

  test("a non-zero bash exit includes the code and a capped stderr snippet", () => {
    expect(
      anomalyLineForResult(
        "bash",
        { command: "false" },
        proc({ exitCode: 1, stderr: "permission denied\nmore" }),
      ),
    ).toBe("exit 1: permission denied");
  });

  test("a timed-out call is an anomaly", () => {
    expect(
      anomalyLineForResult("bash", { command: "sleep 99" }, proc({ timedOut: true, exitCode: 1 })),
    ).toBe("timed out");
  });

  test("write_file failed verification uses the outcome message", () => {
    const verification: CheckOutcome = { status: "failed", reason: "command not found" };
    expect(
      anomalyLineForResult("write_file", { path: "a.txt" }, { written: true, verification }),
    ).toBe("check failed: command not found");
  });

  test("write_file diagnostics verification uses the outcome message", () => {
    const verification: CheckOutcome = {
      status: "diagnostics",
      command: "bun test",
      elapsedMs: 1500,
      diagnostics: [{ file: "a.ts", line: 1, column: 1, message: "err" }],
      inWrittenFile: 1,
      truncated: false,
      total: 1,
    };
    expect(
      anomalyLineForResult("write_file", { path: "a.txt" }, { written: true, verification }),
    ).toBe("1 diagnostic in 1.5s");
  });

  test("a clean write_file is not an anomaly", () => {
    const verification: CheckOutcome = {
      status: "ok",
      command: "bun test",
      elapsedMs: 100,
    };
    expect(
      anomalyLineForResult("write_file", { path: "a.txt" }, { written: true, verification }),
    ).toBeUndefined();
  });

  test("dispatch_subagents with ran < total is an anomaly", () => {
    expect(anomalyLineForResult("dispatch_subagents", {}, dispatchResult(1, 3))).toBe(
      "2 of 3 subagents did not finish",
    );
  });

  test("a clean dispatch_subagents run is not an anomaly", () => {
    expect(anomalyLineForResult("dispatch_subagents", {}, dispatchResult(2, 2))).toBeUndefined();
  });

  test("grep truncated is not an anomaly", () => {
    expect(
      anomalyLineForResult(
        "grep",
        { pattern: "x" },
        {
          mode: "files_with_matches",
          files: ["a.ts"],
          truncated: true,
        },
      ),
    ).toBeUndefined();
  });

  test("a control character in stderr is escaped", () => {
    const line = anomalyLineForResult(
      "bash",
      { command: "false" },
      proc({ exitCode: 1, stderr: "bad\x1bseq" }),
    );
    expect(line).toBeDefined();
    expect(line?.includes("\x1b")).toBe(false);
    expect(line).toContain("\\x1b");
  });
});

describe("anomalyLineForDenial", () => {
  test("blocked", () => {
    expect(anomalyLineForDenial("blocked")).toBe("blocked");
  });

  test("declined", () => {
    expect(anomalyLineForDenial("declined")).toBe("declined");
  });
});

describe("renderToolActivity", () => {
  test("count === 1 with no sub-lines is the singleLine as-written", () => {
    const entries: ToolActivityEntry[] = [
      { name: "read_file", count: 1, singleLine: "Read a.txt", detailLines: [], anomalyLines: [] },
    ];
    expect(renderToolActivity(entries)).toEqual(["Read a.txt"]);
  });

  test("count === 1 with detail lines prefixes each with TREE_BRANCH", () => {
    const entries: ToolActivityEntry[] = [
      {
        name: "grep",
        count: 1,
        singleLine: "Searched TODO",
        detailLines: ["a.ts", "b.ts"],
        anomalyLines: [],
      },
    ];
    expect(renderToolActivity(entries)).toEqual([
      `Searched TODO\n${TREE_BRANCH}a.ts\n${TREE_BRANCH}b.ts`,
    ]);
  });

  test("count === 1 with an anomaly line prefixes it with TREE_BRANCH", () => {
    const entries: ToolActivityEntry[] = [
      {
        name: "bash",
        count: 1,
        singleLine: "Ran false",
        detailLines: [],
        anomalyLines: ["exit 1"],
      },
    ];
    expect(renderToolActivity(entries)).toEqual([`Ran false\n${TREE_BRANCH}exit 1`]);
  });

  test("count > 1 is a pure aggregate", () => {
    const entries: ToolActivityEntry[] = [
      { name: "bash", count: 2, singleLine: "Ran true", detailLines: [], anomalyLines: [] },
    ];
    expect(renderToolActivity(entries)).toEqual(["Ran 2 shell commands"]);
  });

  test("count > 1 still attaches an anomaly line", () => {
    const entries: ToolActivityEntry[] = [
      {
        name: "bash",
        count: 2,
        singleLine: "Ran false",
        detailLines: [],
        anomalyLines: ["exit 1"],
      },
    ];
    expect(renderToolActivity(entries)).toEqual([`Ran 2 shell commands\n${TREE_BRANCH}exit 1`]);
  });

  test("more than 5 sub-lines cap with an overflow note", () => {
    const entries: ToolActivityEntry[] = [
      {
        name: "grep",
        count: 1,
        singleLine: "Searched x",
        detailLines: ["a", "b", "c", "d"],
        anomalyLines: ["e", "f"],
      },
    ];
    const rendered = renderToolActivity(entries)[0];
    expect(rendered).toContain(`${TREE_BRANCH}…and 2 more`);
    expect(rendered.split("\n")).toHaveLength(6);
  });
});

describe("recordCall / recordResult / recordDenial", () => {
  test("recordCall find-or-appends by name", () => {
    let entries = recordCall([], "read_file", { path: "a.txt" });
    entries = recordCall(entries, "read_file", { path: "b.txt" });
    expect(entries).toHaveLength(1);
    expect(entries[0].count).toBe(2);
  });

  test("recordResult on two same-name calls drops grep detail lines", () => {
    const grepOk = {
      mode: "files_with_matches" as const,
      files: ["a.ts"],
      truncated: false,
    };
    let entries = recordResult([], "grep", { pattern: "x" }, grepOk);
    expect(entries[0].detailLines).toEqual(["a.ts"]);
    entries = recordResult(entries, "grep", { pattern: "y" }, grepOk);
    expect(entries).toHaveLength(1);
    expect(entries[0].count).toBe(2);
    expect(entries[0].detailLines).toEqual([]);
  });

  test("dispatch_subagents is never aggregated", () => {
    const result = dispatchResult(1, 1);
    let entries = recordResult([], "dispatch_subagents", {}, result);
    entries = recordResult(entries, "dispatch_subagents", {}, result);
    expect(entries).toHaveLength(2);
  });

  test("recordDenial appends an anomaly line", () => {
    const entries = recordDenial([], "write_file", "declined");
    expect(entries[0].anomalyLines).toEqual(["declined"]);
    expect(entries[0].count).toBe(1);
  });

  test("recordCall then recordResult does not double-count", () => {
    let entries = recordCall([], "read_file", { path: "a.txt" });
    entries = recordResult(entries, "read_file", { path: "a.txt" }, { content: "x" });
    expect(entries[0].count).toBe(1);
    expect(renderToolActivity(entries)).toEqual(["Read a.txt"]);
  });

  test("two failing results in one name-group emit exactly one TREE_BRANCH line", () => {
    const fail = proc({ exitCode: 1, stderr: "boom" });
    let entries = recordResult([], "bash", { command: "false" }, fail);
    entries = recordResult(entries, "bash", { command: "false" }, fail);
    const rendered = renderToolActivity(entries)[0] ?? "";
    const branches = rendered.split("\n").filter((line) => line.startsWith(TREE_BRANCH));
    expect(entries[0].count).toBe(2);
    expect(branches).toHaveLength(1);
  });
});

describe("renderLiveToolActivity", () => {
  test("skips an open count===1 entry so the first in-flight call is only pendingTool", () => {
    const entries = recordCall([], "read_file", { path: "a.txt" });
    expect(renderLiveToolActivity(entries)).toEqual([]);
    expect(renderToolActivity(entries)).toEqual(["Read a.txt"]);
  });

  test("open count>1 paints at count-1 until the next result lands", () => {
    let entries = recordCall([], "read_file", { path: "a.txt" });
    entries = recordResult(entries, "read_file", { path: "a.txt" }, { content: "x" });
    expect(renderLiveToolActivity(entries)).toEqual(["Read a.txt"]);
    entries = recordCall(entries, "read_file", { path: "b.txt" });
    expect(renderLiveToolActivity(entries)).toEqual(["Read a.txt"]);
    entries = recordResult(entries, "read_file", { path: "b.txt" }, { content: "y" });
    expect(renderLiveToolActivity(entries)).toEqual(["Read 2 files"]);
  });

  test("same open-count filter applies to bash, not only read_file", () => {
    const ok = proc();
    let entries = recordCall([], "bash", { command: "echo a" });
    entries = recordResult(entries, "bash", { command: "echo a" }, ok);
    expect(renderLiveToolActivity(entries)).toEqual(["Ran echo a"]);
    entries = recordCall(entries, "bash", { command: "echo b" });
    expect(renderLiveToolActivity(entries)).toEqual(["Ran echo a"]);
    entries = recordResult(entries, "bash", { command: "echo b" }, ok);
    expect(renderLiveToolActivity(entries)).toEqual(["Ran 2 shell commands"]);
  });
});
