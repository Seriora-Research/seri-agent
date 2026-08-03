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
    "Run a shell command via bash. Output is capped at 30000 characters; when `truncated` is true the middle was dropped and both ends kept, so redirect to a file and read the part you need rather than assuming this is the whole output.",
  inputSchema: z.object({ command: z.string() }),
  execute: async ({ command }) => runBash(command),
});

const powershellTool = tool({
  description:
    "Run a shell command via PowerShell. Output is capped at 30000 characters; when `truncated` is true the middle was dropped and both ends kept, so redirect to a file and read the part you need rather than assuming this is the whole output.",
  inputSchema: z.object({ command: z.string() }),
  execute: async ({ command }) => runPowerShell(command),
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
