import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { DispatchResult } from "../../src/subagents/dispatch";
import type { ProcessResult } from "../../src/tools/spawnCollect";
import {
  anomalyLineForDenial,
  anomalyLineForResult,
  anomalyLineForThrow,
  detailLinesForResult,
  recordCall,
  recordDenial,
  recordResult,
  recordThrow,
  renderLiveToolActivity,
  renderToolActivity,
  summarizeArgs,
  type ToolActivityEntry,
  trimPath,
} from "../../src/tui/state/toolActivity";
import { TOOL_INDENT } from "../../src/tui/theme/spacing";
import { TREE_BRANCH, TREE_MID } from "../../src/tui/theme/theme";
import type { CheckOutcome } from "../../src/verify/outcome";

const I = TOOL_INDENT;

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

describe("anomalyLineForThrow", () => {
  test("strips the loop wrapper and maps ENOENT", () => {
    expect(
      anomalyLineForThrow(
        `Tool "read_file" threw during execution: Error: ENOENT: no such file or directory, open 'C:\\\\Users\\\\x\\\\docs\\\\ROADMAP.md'`,
      ),
    ).toBe("file not found");
  });

  test("maps EACCES and EPERM to permission denied", () => {
    expect(anomalyLineForThrow("Error: EACCES: permission denied, open '/etc/shadow'")).toBe(
      "permission denied",
    );
    expect(anomalyLineForThrow("EPERM: operation not permitted, unlink 'a.lock'")).toBe(
      "permission denied",
    );
  });

  test("keeps a tool's own first-line message", () => {
    expect(
      anomalyLineForThrow('Tool "write_file" threw during execution: Error: Cannot write to reserved device name: CON'),
    ).toBe("Cannot write to reserved device name: CON");
  });

  test("an empty remainder becomes failed", () => {
    expect(anomalyLineForThrow('Tool "read_file" threw during execution: ')).toBe("failed");
  });
});

describe("renderToolActivity", () => {
  test("a group is its call line with the result indented under it", () => {
    const entries: ToolActivityEntry[] = [
      {
        name: "read_file",
        count: 1,
        callLine: "→ Read(a.txt)",
        singleLine: "Read a.txt",
        detailLines: [],
        anomalyLines: [],
      },
    ];
    expect(renderToolActivity(entries)).toEqual([`→ Read(a.txt)\n${I}Read 1 file`]);
  });

  test("the result line counts even a single call, so it never repeats the call line", () => {
    const entries: ToolActivityEntry[] = [
      {
        name: "bash",
        count: 1,
        callLine: "→ Bash(bun test)",
        singleLine: "Ran bun test",
        detailLines: [],
        anomalyLines: [],
      },
    ];
    expect(renderToolActivity(entries)).toEqual([`→ Bash(bun test)\n${I}Ran 1 shell command`]);
  });

  test("detail lines keep TREE_BRANCH and sit at the result line's indent", () => {
    const entries: ToolActivityEntry[] = [
      {
        name: "grep",
        count: 1,
        callLine: "→ Grep(TODO)",
        singleLine: "Searched TODO",
        detailLines: ["a.ts", "b.ts"],
        anomalyLines: [],
      },
    ];
    expect(renderToolActivity(entries)).toEqual([
      `→ Grep(TODO)\n${I}Searched 1 file\n${I}${TREE_BRANCH}a.ts\n${I}${TREE_BRANCH}b.ts`,
    ]);
  });

  test("an anomaly line keeps TREE_BRANCH", () => {
    const entries: ToolActivityEntry[] = [
      {
        name: "bash",
        count: 1,
        callLine: "→ Bash(false)",
        singleLine: "Ran false",
        detailLines: [],
        anomalyLines: ["exit 1"],
      },
    ];
    expect(renderToolActivity(entries)).toEqual([
      `→ Bash(false)\n${I}Ran 1 shell command\n${I}${TREE_BRANCH}exit 1`,
    ]);
  });

  test("count > 1 pluralises the noun", () => {
    const entries: ToolActivityEntry[] = [
      {
        name: "bash",
        count: 2,
        callLine: "→ Bash(true)",
        singleLine: "Ran true",
        detailLines: [],
        anomalyLines: [],
      },
    ];
    expect(renderToolActivity(entries)).toEqual([`→ Bash(true)\n${I}Ran 2 shell commands`]);
  });

  test("grep count > 1 uses the files noun", () => {
    const entries: ToolActivityEntry[] = [
      {
        name: "grep",
        count: 2,
        callLine: "→ Grep(TODO)",
        singleLine: "Searched TODO",
        detailLines: [],
        anomalyLines: [],
      },
    ];
    expect(renderToolActivity(entries)).toEqual([`→ Grep(TODO)\n${I}Searched 2 files`]);
  });

  test("glob count > 1 uses the files noun", () => {
    const entries: ToolActivityEntry[] = [
      {
        name: "glob",
        count: 2,
        callLine: "→ Glob(**/*.ts)",
        singleLine: "Searched **/*.ts",
        detailLines: [],
        anomalyLines: [],
      },
    ];
    expect(renderToolActivity(entries)).toEqual([`→ Glob(**/*.ts)\n${I}Searched 2 files`]);
  });

  test("count > 1 still attaches an anomaly line", () => {
    const entries: ToolActivityEntry[] = [
      {
        name: "bash",
        count: 2,
        callLine: "→ Bash(false)",
        singleLine: "Ran false",
        detailLines: [],
        anomalyLines: ["exit 1"],
      },
    ];
    expect(renderToolActivity(entries)).toEqual([
      `→ Bash(false)\n${I}Ran 2 shell commands\n${I}${TREE_BRANCH}exit 1`,
    ]);
  });

  test("a settles tool keeps its own settled line instead of a count", () => {
    const entries: ToolActivityEntry[] = [
      {
        name: "edit",
        count: 1,
        callLine: "→ Edit",
        singleLine: "✓ Edit done (text returned, nothing written)",
        detailLines: [],
        anomalyLines: [],
      },
    ];
    expect(renderToolActivity(entries)).toEqual([
      `→ Edit\n${I}✓ Edit done (text returned, nothing written)`,
    ]);
  });

  test("a settles tool falls back to the count once it is a group", () => {
    const entries: ToolActivityEntry[] = [
      {
        name: "edit",
        count: 2,
        callLine: "→ Edit",
        singleLine: "✓ Edit done (text returned, nothing written)",
        detailLines: [],
        anomalyLines: [],
      },
    ];
    expect(renderToolActivity(entries)).toEqual([`→ Edit\n${I}Edited 2 edits`]);
  });

  // The fixtures above pass `callLine` in, so they cannot show where it comes from. This one goes
  // through recordCall and asserts on the label, which is the whole point of the display column.
  test("a group is named by its display label, never by the wire name the model called", () => {
    const entries = recordResult(
      recordCall([], "read_file", { path: "a.txt" }),
      "read_file",
      { path: "a.txt" },
      { content: "x" },
    );
    const rendered = renderToolActivity(entries)[0] ?? "";
    expect(rendered.split("\n")[0]).toBe("→ Read(a.txt)");
    expect(rendered).not.toContain("read_file");
  });

  test("a write_file group's settled line takes the label too, not toolResultLine's wire name", () => {
    const entries = recordResult([], "write_file", { path: "a.txt" }, { written: true });
    const rendered = renderToolActivity(entries)[0] ?? "";
    expect(rendered.split("\n")[0]).toBe("→ Write(a.txt)");
    expect(rendered).toContain("✓ Write done");
    expect(rendered).not.toContain("write_file");
  });

  // recordDenial is the only recorder that builds a dispatch group, so a denied dispatch is the
  // only way one reaches the screen. It reads like every other group rather than naming the wire
  // tool twice.
  test("a denied dispatch reads as a labelled group, not as the wire name", () => {
    const entries = recordDenial([], "dispatch_subagents", "declined");
    const rendered = renderToolActivity(entries)[0] ?? "";
    expect(rendered).toBe(`→ Dispatch\n${I}Dispatched 1 subagent\n${I}${TREE_BRANCH}declined`);
    expect(rendered).not.toContain("dispatch_subagents");
  });

  // A name the model invented, denied by the gate, is the group that reaches the renderer with no
  // table entry. With no noun there is nothing to count, so it keeps its settled text; `×N` is
  // still what a real group of them reads as.
  test("a group with no table entry keeps its settled line at one call, not a ×N count", () => {
    const entries = recordDenial([], "not_a_real_tool", "blocked");
    const rendered = renderToolActivity(entries)[0] ?? "";
    expect(rendered.split("\n")[1]).toBe(`${I}not_a_real_tool`);
    expect(rendered).not.toContain("×");
  });

  test("two of them do read as a ×N group", () => {
    let entries = recordDenial([], "not_a_real_tool", "blocked");
    entries = recordDenial(entries, "not_a_real_tool", "blocked");
    expect(renderToolActivity(entries)[0]?.split("\n")[1]).toBe(`${I}not_a_real_tool ×2`);
  });

  // Spelled as a literal, unlike every other test in this describe: the rest build their expected
  // string out of TOOL_INDENT, so emptying that constant moves the assertion with the code and
  // every one of them stays green. This is the test that goes red for it.
  test("the result line is indented exactly two columns", () => {
    const entries: ToolActivityEntry[] = [
      {
        name: "read_file",
        count: 1,
        callLine: "→ Read(a.txt)",
        singleLine: "Read a.txt",
        detailLines: [],
        anomalyLines: [],
      },
    ];
    expect(renderToolActivity(entries)).toEqual(["→ Read(a.txt)\n  Read 1 file"]);
  });

  test("more than 5 sub-lines cap with an overflow note", () => {
    const entries: ToolActivityEntry[] = [
      {
        name: "grep",
        count: 1,
        callLine: "→ Grep(x)",
        singleLine: "Searched x",
        detailLines: ["a", "b", "c", "d"],
        anomalyLines: ["e", "f"],
      },
    ];
    const rendered = renderToolActivity(entries)[0];
    expect(rendered).toContain(`${I}${TREE_BRANCH}…and 2 more`);
    expect(rendered.split("\n")).toHaveLength(7);
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
    expect(entries).toEqual([]);
  });

  test("recordDenial appends an anomaly line", () => {
    const entries = recordDenial([], "write_file", "declined");
    expect(entries[0].anomalyLines).toEqual(["declined"]);
    expect(entries[0].count).toBe(1);
  });

  test("recordCall then recordThrow settles the open group with one anomaly", () => {
    let entries = recordCall([], "read_file", { path: "docs/ROADMAP.md" });
    entries = recordThrow(
      entries,
      "read_file",
      { path: "docs/ROADMAP.md" },
      `Tool "read_file" threw during execution: Error: ENOENT: no such file or directory, open 'docs/ROADMAP.md'`,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].count).toBe(1);
    expect(entries[0].open).toBe(false);
    expect(entries[0].anomalyLines).toEqual(["file not found"]);
    expect(renderLiveToolActivity(entries)[0]).toContain(`${I}${TREE_BRANCH}file not found`);
    expect(renderLiveToolActivity(entries)[0]).not.toContain("threw during execution");
  });

  test("recordCall then recordResult does not double-count", () => {
    let entries = recordCall([], "read_file", { path: "a.txt" });
    entries = recordResult(entries, "read_file", { path: "a.txt" }, { content: "x" });
    expect(entries[0].count).toBe(1);
    expect(renderToolActivity(entries)).toEqual([`→ Read(a.txt)\n${I}Read 1 file`]);
  });

  test("two failing results in one name-group emit exactly one TREE_BRANCH line", () => {
    const fail = proc({ exitCode: 1, stderr: "boom" });
    let entries = recordResult([], "bash", { command: "false" }, fail);
    entries = recordResult(entries, "bash", { command: "false" }, fail);
    const rendered = renderToolActivity(entries)[0] ?? "";
    const branches = rendered.split("\n").filter((line) => line.startsWith(`${I}${TREE_BRANCH}`));
    expect(entries[0].count).toBe(2);
    expect(branches).toHaveLength(1);
  });
});

describe("renderLiveToolActivity", () => {
  test("skips an open count===1 entry so the first in-flight call is only pendingTool", () => {
    const entries = recordCall([], "read_file", { path: "a.txt" });
    expect(renderLiveToolActivity(entries)).toEqual([]);
    expect(renderToolActivity(entries)).toEqual([`→ Read(a.txt)\n${I}Read 1 file`]);
  });

  test("open count>1 paints at count-1 until the next result lands", () => {
    let entries = recordCall([], "read_file", { path: "a.txt" });
    entries = recordResult(entries, "read_file", { path: "a.txt" }, { content: "x" });
    expect(renderLiveToolActivity(entries)).toEqual([`→ Read(a.txt)\n${I}Read 1 file`]);
    entries = recordCall(entries, "read_file", { path: "b.txt" });
    expect(renderLiveToolActivity(entries)).toEqual([`→ Read(a.txt)\n${I}Read 1 file`]);
    entries = recordResult(entries, "read_file", { path: "b.txt" }, { content: "y" });
    expect(renderLiveToolActivity(entries)).toEqual([`→ Read(a.txt)\n${I}Read 2 files`]);
  });

  test("same open-count filter applies to bash, not only read_file", () => {
    const ok = proc();
    let entries = recordCall([], "bash", { command: "echo a" });
    entries = recordResult(entries, "bash", { command: "echo a" }, ok);
    expect(renderLiveToolActivity(entries)).toEqual([`→ Bash(echo a)\n${I}Ran 1 shell command`]);
    entries = recordCall(entries, "bash", { command: "echo b" });
    expect(renderLiveToolActivity(entries)).toEqual([`→ Bash(echo a)\n${I}Ran 1 shell command`]);
    entries = recordResult(entries, "bash", { command: "echo b" }, ok);
    expect(renderLiveToolActivity(entries)).toEqual([`→ Bash(echo a)\n${I}Ran 2 shell commands`]);
  });
});

describe("MCP grouping", () => {
  test("three different MCP tools group into one line plus three children, mid then branch", () => {
    let entries = recordResult([], "mcp_exa_web_search", {}, { ok: true });
    entries = recordResult(entries, "mcp_notion_search", {}, { ok: true });
    entries = recordResult(entries, "mcp_hugging_face_model_search", {}, { ok: true });
    expect(entries).toHaveLength(1);
    expect(entries[0].count).toBe(3);
    expect(renderToolActivity(entries)).toEqual([
      `→ mcp_exa_web_search\n${I}Ran MCP 3 tools\n${I}${TREE_MID}mcp_exa_web_search\n${I}${TREE_MID}mcp_notion_search\n${I}${TREE_BRANCH}mcp_hugging_face_model_search`,
    ]);
  });

  test("same turn: a grep group still renders TREE_BRANCH on every child while an MCP group alternates", () => {
    // grep's sub-lines are a sample of matched paths, so TREE_BRANCH on each is unchanged from
    // today; MCP's are the complete call list, so it alternates. Rendering both from one call
    // proves the renderer distinguishes the two groups rather than switching on some global.
    const grepEntry: ToolActivityEntry = {
      name: "grep",
      count: 1,
      callLine: "→ Grep(TODO)",
      singleLine: "Searched TODO",
      detailLines: ["a.ts", "b.ts"],
      anomalyLines: [],
    };
    let mcpEntries = recordResult([], "mcp_exa_web_search", {}, { ok: true });
    mcpEntries = recordResult(mcpEntries, "mcp_notion_search", {}, { ok: true });
    const rendered = renderToolActivity([grepEntry, ...mcpEntries]);
    expect(rendered[0]).toBe(
      `→ Grep(TODO)\n${I}Searched 1 file\n${I}${TREE_BRANCH}a.ts\n${I}${TREE_BRANCH}b.ts`,
    );
    expect(rendered[1]).toBe(
      `→ mcp_exa_web_search\n${I}Ran MCP 2 tools\n${I}${TREE_MID}mcp_exa_web_search\n${I}${TREE_BRANCH}mcp_notion_search`,
    );
  });

  test("a single MCP call names itself on the call line and counts one on the result line", () => {
    const entries = recordResult([], "mcp_exa_web_search", {}, { ok: true });
    expect(entries).toHaveLength(1);
    expect(entries[0].count).toBe(1);
    expect(renderToolActivity(entries)).toEqual([`→ mcp_exa_web_search\n${I}Ran MCP 1 tool`]);
  });

  test("two calls to the same MCP tool still group into the one bucket", () => {
    let entries = recordResult([], "mcp_exa_web_search", {}, { ok: true });
    entries = recordResult(entries, "mcp_exa_web_search", {}, { ok: true });
    expect(entries).toHaveLength(1);
    expect(entries[0].count).toBe(2);
    expect(renderToolActivity(entries)[0]?.split("\n")[1]).toBe(`${I}Ran MCP 2 tools`);
  });

  test("built-in grouping is unchanged: two read_file calls group by exact name, undisturbed by an MCP call in the same turn", () => {
    let entries = recordResult([], "read_file", { path: "a.txt" }, "one");
    entries = recordResult(entries, "read_file", { path: "b.txt" }, "two");
    entries = recordResult(entries, "mcp_exa_web_search", {}, { ok: true });
    expect(entries).toHaveLength(2);
    const readFileEntry = entries.find((e) => e.name === "read_file");
    const mcpEntry = entries.find((e) => e.name === "mcp");
    expect(readFileEntry?.count).toBe(2);
    expect(renderToolActivity([readFileEntry as ToolActivityEntry])).toEqual([
      `→ Read(a.txt)\n${I}Read 2 files`,
    ]);
    expect(mcpEntry?.count).toBe(1);
    expect(renderToolActivity([mcpEntry as ToolActivityEntry])).toEqual([
      `→ mcp_exa_web_search\n${I}Ran MCP 1 tool`,
    ]);
  });

  test("overflow past the sub-line cap summarises through cappedSubLines", () => {
    let entries: ToolActivityEntry[] = [];
    for (let i = 1; i <= 6; i++) {
      entries = recordResult(entries, `mcp_t${i}`, {}, { ok: true });
    }
    expect(entries[0].count).toBe(6);
    const rendered = renderToolActivity(entries)[0] ?? "";
    const lines = rendered.split("\n");
    expect(lines[0]).toBe("→ mcp_t1");
    expect(lines[1]).toBe(`${I}Ran MCP 6 tools`);
    expect(lines).toHaveLength(7);
    expect(lines.at(-1)).toBe(`${I}${TREE_BRANCH}…and 2 more`);
  });

  test("a failed MCP call still gets its anomaly sub-line", () => {
    const entries = recordDenial([], "mcp_exa_web_search", "blocked");
    expect(entries[0].anomalyLines).toEqual(["blocked"]);
    expect(renderToolActivity(entries)).toEqual([
      `→ mcp_exa_web_search\n${I}Ran MCP 1 tool\n${I}${TREE_BRANCH}blocked`,
    ]);
  });
});
