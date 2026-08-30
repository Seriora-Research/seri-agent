import { isAbsolute, resolve } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { isBashAvailable, runBash } from "../tools/bash";
import { edit } from "../tools/edit";
import { glob } from "../tools/glob";
import { grep } from "../tools/grep";
import { runPowerShell } from "../tools/powershell";
import { readFile } from "../tools/readFile";
import { MAX_FILE_RESULTS, MAX_RESULTS } from "../tools/runRipgrep";
import { writeFile } from "../tools/writeFile";

// Relative paths resolve against the session cwd, not process.cwd(). A daemon hosts concurrent
// sessions and never calls chdir, so each toolset has to carry its own directory.
function resolveAgainstCwd(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export function createToolDefinitions(cwd: string) {
  const readFileTool = tool({
    description: "Read a file's contents as text.",
    inputSchema: z.object({ path: z.string() }),
    execute: ({ path }) => readFile(resolveAgainstCwd(cwd, path)),
  });

  const writeFileTool = tool({
    description:
      "Write text content to a file, atomically. If the user has configured a check command, it runs " +
      "after a successful write and the result carries its diagnostics. They are ADVISORY — the write " +
      "already happened and is not rolled back. The check covers whatever the configured command " +
      "covers, usually the whole project, so diagnostics may be PRE-EXISTING and in files you never " +
      "touched: `inWrittenFile` says how many of the returned diagnostics are in the file you just " +
      "wrote, and those are listed first. `total` is how many the check reported, which is more than " +
      "the list when it was capped. Fix what you caused; do not start editing unrelated files because " +
      "the project already had errors in them.",
    inputSchema: z.object({
      path: z.string(),
      content: z.string(),
      eol: z.enum(["LF", "CRLF"]).optional(),
    }),
    execute: ({ path, content, eol }) =>
      writeFile(resolveAgainstCwd(cwd, path), content, eol ? { eol } : undefined),
  });

  const editTool = tool({
    description:
      "Replace oldString with newString in the given content and return the result. oldString must " +
      "appear exactly once in content: include enough surrounding lines to make it unique, because " +
      "this errors rather than guessing which occurrence you meant. Nothing is written to disk: pass " +
      "the returned text to write_file to persist it.",
    inputSchema: z.object({
      content: z.string(),
      oldString: z.string(),
      newString: z.string(),
    }),
    execute: ({ content, oldString, newString }) => edit(content, oldString, newString),
  });

  const grepTool = tool({
    description: `Search for a pattern in files under a path using ripgrep. Defaults to returning only the names of files that match, which is what most searches need and costs a fraction of the tokens; pass mode "content" only when you actually need the matched lines, or "count" for per-file totals. Returns at most ${MAX_FILE_RESULTS} files or ${MAX_RESULTS} matched lines; when \`truncated\` is true the results are incomplete and re-running the same search can return a different subset, so narrow the pattern or path, or pass a glob, rather than assuming these are all of them.`,
    inputSchema: z.object({
      pattern: z.string(),
      path: z.string(),
      glob: z.string().optional(),
      mode: z.enum(["files_with_matches", "content", "count"]).optional(),
    }),
    // The second argument is the AI SDK's execution options, and this is the only place in the
    // program that holds both the signal and the call into the search — discard it here and a
    // cancel reaches the tool boundary and stops there.
    execute: ({ pattern, path, glob: globFilter, mode }, { abortSignal }) =>
      grep(pattern, { path: resolveAgainstCwd(cwd, path), glob: globFilter, mode }, abortSignal),
  });

  const globTool = tool({
    description: `List files under a path matching a glob pattern. Returns at most ${MAX_FILE_RESULTS} files; when \`truncated\` is true the results are incomplete and re-running the same search can return a different subset, so narrow the pattern or path rather than assuming these are all of them.`,
    inputSchema: z.object({
      pattern: z.string(),
      path: z.string(),
    }),
    execute: ({ pattern, path }, { abortSignal }) =>
      glob(pattern, { path: resolveAgainstCwd(cwd, path) }, abortSignal),
  });

  const bashTool = tool({
    description:
      "Run a shell command via bash. Each stream is capped at 30000 characters; `stdoutTruncated` and `stderrTruncated` say which one was cut, and a cut drops the middle and keeps both ends, so redirect that stream to a file and read the part you need rather than assuming it is the whole output. Commands are killed after 2 minutes and `timedOut` is set, with whatever they printed first; pass timeoutMs (up to 600000) for a command you expect to take longer.",
    inputSchema: z.object({ command: z.string(), timeoutMs: z.number().optional() }),
    // Same reason as grep/glob above, and one more: spawnCollect only rejects a killed child when it
    // was handed the signal, so without this argument a command the user cancelled runs to completion
    // and comes back as an ordinary successful ProcessResult. Measured before this line existed —
    // `sleep 4; echo FINISHED-ANYWAY` with an already-aborted signal took 4072 ms and returned
    // exitCode 0.
    execute: async ({ command, timeoutMs }, { abortSignal }) =>
      runBash(command, timeoutMs, abortSignal, isBashAvailable, cwd),
  });

  const powershellTool = tool({
    description:
      "Run a shell command via PowerShell. Each stream is capped at 30000 characters; `stdoutTruncated` and `stderrTruncated` say which one was cut, and a cut drops the middle and keeps both ends, so redirect that stream to a file and read the part you need rather than assuming it is the whole output. Commands are killed after 2 minutes and `timedOut` is set, with whatever they printed first; pass timeoutMs (up to 600000) for a command you expect to take longer.",
    inputSchema: z.object({ command: z.string(), timeoutMs: z.number().optional() }),
    execute: async ({ command, timeoutMs }, { abortSignal }) =>
      runPowerShell(command, timeoutMs, abortSignal, cwd),
  });

  return {
    read_file: readFileTool,
    write_file: writeFileTool,
    edit: editTool,
    grep: grepTool,
    glob: globTool,
    bash: bashTool,
    powershell: powershellTool,
  };
}

export const toolDefinitions = createToolDefinitions(process.cwd());

// Tools that write to disk or execute commands, as opposed to merely reading/searching.
// Still the only place a built-in's permission class is declared: classifyBuiltin (below) is what
// gate.ts asks, and its read class is READ_ONLY_TOOL_NAMES — this list's complement over
// toolDefinitions — so there is no second list to keep in step and a write-capable tool can't
// silently drift out of sync with what read-only mode blocks.
export const WRITE_TOOL_NAMES: (keyof typeof toolDefinitions)[] = [
  "write_file",
  "edit",
  "bash",
  "powershell",
];

// Tools that can change the contents of the filesystem, which is what a checkpoint has to be
// taken in front of. Deliberately NOT WRITE_TOOL_NAMES: that set is the *permission*
// classification and contains `edit`, but `edit()` (tools/edit.ts:102) is
// `(content: string, oldString, newString) => string` — a pure string transform whose schema
// takes the content itself, not a path. It never touches disk; the model has to follow up with
// `write_file`. Snapshotting on it would only ever produce a checkpoint identical to its
// predecessor. Kept as a separate list rather than derived from the other so the two can each be
// wrong independently: a tool that needs approval but writes nothing, or (worse) one that writes
// without needing approval, must not be forced to be the same mistake twice.
export const FS_MUTATING_TOOL_NAMES: (keyof typeof toolDefinitions)[] = [
  "write_file",
  "bash",
  "powershell",
];

export type ToolName = keyof typeof toolDefinitions;

// Derived from toolDefinitions minus WRITE_TOOL_NAMES, not hand-listed: a new write-capable tool
// is excluded by construction instead of by remembering to update a second list — the same
// rationale WRITE_TOOL_NAMES' own comment gives for gate.ts.
export const READ_ONLY_TOOL_NAMES: readonly ToolName[] = (
  Object.keys(toolDefinitions) as ToolName[]
).filter((name) => !WRITE_TOOL_NAMES.includes(name));

export function createScheduledToolDefinitions(cwd: string) {
  const all = createToolDefinitions(cwd);
  return {
    read_file: all.read_file,
    grep: all.grep,
    glob: all.glob,
  };
}

// Not a key of toolDefinitions, and that absence IS the one-level subagent recursion guard
// (subagents/registry.ts): every subagent's ToolSet is built by picking names out of
// toolDefinitions, so `ToolName` can never name this tool and no child ToolSet can contain it.
export const DISPATCH_TOOL_NAME = "dispatch_subagents";

export type ToolClass = "read" | "write";

// The read class is enumerated and everything else is `write`, including every name this file has
// never heard of. That direction is the whole point: MCP opens the tool set to third parties, so
// "absent from the write list" stops being evidence of safety — absence of knowledge never was —
// and an unseen name costs an approval instead of being waved through in all three modes.
//
// Two names here are not keys of `toolDefinitions` and would therefore be unknown, which would
// break read-only sessions that use them. Neither writes: `dispatch_subagents` hands the child the
// parent's own permission mode (subagents/dispatch.ts), so a subagent's `bash` re-enters this same
// gate at the same mode rather than escaping it, and `skill` reads one file the user themselves put
// under `.seri/skills/`.
//
// `skill` is the literal rather than an import of SKILL_TOOL_NAME (skills/tool.ts) because
// `provider/` sits below `skills/` in the module graph, and the foundational modules here do not
// import the extension modules layered on top of them. The drift a literal invites is guarded in
// tests/provider/tools.test.ts, which imports the constant and asserts the two still agree — a
// cross-module import that costs nothing in a test.
const READ_CLASS_TOOL_NAMES = new Set<string>([
  ...READ_ONLY_TOOL_NAMES,
  DISPATCH_TOOL_NAME,
  "skill",
]);

export function classifyBuiltin(name: string): ToolClass {
  return READ_CLASS_TOOL_NAMES.has(name) ? "read" : "write";
}
