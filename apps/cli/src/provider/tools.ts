import { tool } from "ai";
import { z } from "zod";
import { runBash } from "../tools/bash";
import { edit } from "../tools/edit";
import { glob } from "../tools/glob";
import { grep } from "../tools/grep";
import { runPowerShell } from "../tools/powershell";
import { MAX_FILE_RESULTS, MAX_RESULTS } from "../tools/runRipgrep";
import { readFile } from "../tools/readFile";
import { writeFile } from "../tools/writeFile";

const readFileTool = tool({
  description: "Read a file's contents as text.",
  inputSchema: z.object({ path: z.string() }),
  execute: ({ path }) => readFile(path),
});

const writeFileTool = tool({
  description: "Write text content to a file, atomically.",
  inputSchema: z.object({
    path: z.string(),
    content: z.string(),
    eol: z.enum(["LF", "CRLF"]).optional(),
  }),
  execute: ({ path, content, eol }) => writeFile(path, content, eol ? { eol } : undefined),
});

const editTool = tool({
  description: "Replace the first occurrence of oldString with newString in the given content.",
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
  execute: ({ pattern, path, glob: globFilter, mode }) => grep(pattern, { path, glob: globFilter, mode }),
});

const globTool = tool({
  description: `List files under a path matching a glob pattern. Returns at most ${MAX_FILE_RESULTS} files; when \`truncated\` is true the results are incomplete and re-running the same search can return a different subset, so narrow the pattern or path rather than assuming these are all of them.`,
  inputSchema: z.object({
    pattern: z.string(),
    path: z.string(),
  }),
  execute: ({ pattern, path }) => glob(pattern, { path }),
});

const bashTool = tool({
  description:
    "Run a shell command via bash. Each stream is capped at 30000 characters; `stdoutTruncated` and `stderrTruncated` say which one was cut, and a cut drops the middle and keeps both ends, so redirect that stream to a file and read the part you need rather than assuming it is the whole output. Commands are killed after 2 minutes and `timedOut` is set, with whatever they printed first; pass timeoutMs (up to 600000) for a command you expect to take longer.",
  inputSchema: z.object({ command: z.string(), timeoutMs: z.number().optional() }),
  execute: async ({ command, timeoutMs }) => runBash(command, undefined, timeoutMs),
});

const powershellTool = tool({
  description:
    "Run a shell command via PowerShell. Each stream is capped at 30000 characters; `stdoutTruncated` and `stderrTruncated` say which one was cut, and a cut drops the middle and keeps both ends, so redirect that stream to a file and read the part you need rather than assuming it is the whole output. Commands are killed after 2 minutes and `timedOut` is set, with whatever they printed first; pass timeoutMs (up to 600000) for a command you expect to take longer.",
  inputSchema: z.object({ command: z.string(), timeoutMs: z.number().optional() }),
  execute: async ({ command, timeoutMs }) => runPowerShell(command, timeoutMs),
});

export const toolDefinitions = {
  read_file: readFileTool,
  write_file: writeFileTool,
  edit: editTool,
  grep: grepTool,
  glob: globTool,
  bash: bashTool,
  powershell: powershellTool,
};

// Tools that write to disk or execute commands, as opposed to merely reading/searching.
// gate.ts derives its permission set from this list so a new write-capable tool can't
// silently drift out of sync with what read-only mode blocks.
export const WRITE_TOOL_NAMES: (keyof typeof toolDefinitions)[] = ["write_file", "edit", "bash", "powershell"];

// Tools that can change the contents of the filesystem, which is what a checkpoint has to be
// taken in front of. Deliberately NOT WRITE_TOOL_NAMES: that set is the *permission*
// classification and contains `edit`, but `edit()` (tools/edit.ts:100) is
// `(content: string, oldString, newString) => string` — a pure string transform whose schema
// takes the content itself, not a path. It never touches disk; the model has to follow up with
// `write_file`. Snapshotting on it would only ever produce a checkpoint identical to its
// predecessor. Kept as a separate list rather than derived from the other so the two can each be
// wrong independently: a tool that needs approval but writes nothing, or (worse) one that writes
// without needing approval, must not be forced to be the same mistake twice.
export const FS_MUTATING_TOOL_NAMES: (keyof typeof toolDefinitions)[] = ["write_file", "bash", "powershell"];
