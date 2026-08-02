import { tool } from "ai";
import { z } from "zod";
import { runBash } from "../tools/bash";
import { edit } from "../tools/edit";
import { glob } from "../tools/glob";
import { grep } from "../tools/grep";
import { runPowerShell } from "../tools/powershell";
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
  description: "Search for a pattern in files under a path using ripgrep.",
  inputSchema: z.object({
    pattern: z.string(),
    path: z.string(),
    glob: z.string().optional(),
  }),
  execute: ({ pattern, path, glob: globFilter }) => grep(pattern, { path, glob: globFilter }),
});

const globTool = tool({
  description: "List files under a path matching a glob pattern.",
  inputSchema: z.object({
    pattern: z.string(),
    path: z.string(),
  }),
  execute: ({ pattern, path }) => glob(pattern, { path }),
});

const bashTool = tool({
  description: "Run a shell command via bash.",
  inputSchema: z.object({ command: z.string() }),
  execute: async ({ command }) => runBash(command),
});

const powershellTool = tool({
  description: "Run a shell command via PowerShell.",
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
