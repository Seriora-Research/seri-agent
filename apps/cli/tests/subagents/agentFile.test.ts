import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DISPATCH_TOOL_NAME,
  READ_ONLY_TOOL_NAMES,
  toolDefinitions,
} from "../../src/provider/tools";
import { type AgentFileOutcome, parseAgentFile } from "../../src/subagents/agentFile";




const CURSOR_FIXTURE = readFileSync(
  join(import.meta.dir, "fixtures", "cursor-reviewer-verifier.md"),
  "utf8",
);

function parse(
  text: string,
  opts: {
    filePath?: string;
    reserved?: readonly string[];
    models?: Readonly<Record<string, "groq" | "anthropic">>;
  } = {},
): AgentFileOutcome {
  const reserved = new Set(opts.reserved ?? []);
  const models = opts.models ?? {};
  return parseAgentFile({
    filePath: opts.filePath ?? "/agents/reviewer.md",
    text,
    source: "project",
    isReserved: (name) => reserved.has(name),
    resolveModel: (id) => {
      const provider = models[id];
      return provider === undefined ? undefined : { model: id, provider };
    },
  });
}

function spec(outcome: AgentFileOutcome) {
  if (outcome.kind !== "spec") throw new Error(`expected a spec, got skipped: ${outcome.warning}`);
  return outcome.spec;
}

describe("parseAgentFile — the committed .cursor/agents/reviewer-verifier.md", () => {
  test("loads with the filename as its name and the frontmatter description", () => {
    const parsed = spec(
      parse(CURSOR_FIXTURE, { filePath: "/p/.seri/agents/reviewer-verifier.md" }),
    );
    expect(parsed.name).toBe("reviewer-verifier");
    expect(parsed.description).toContain("Independent reviewer");
    expect(parsed.source).toBe("project");
    expect(parsed.filePath).toBe("/p/.seri/agents/reviewer-verifier.md");
  });

  test("its Claude Code tool names fold onto seri's, in file order", () => {
    expect(spec(parse(CURSOR_FIXTURE)).toolNames).toEqual(["read_file", "grep", "glob", "bash"]);
  });

  test("model: inherit leaves no pin, and effort: high still travels", () => {
    expect(spec(parse(CURSOR_FIXTURE)).request).toEqual({ effort: "high" });
  });

  test("permissionMode is tolerated and ignored — no key of it survives on the spec", () => {
    expect(JSON.stringify(spec(parse(CURSOR_FIXTURE)))).not.toContain("permissionMode");
  });

  test("the body is the addendum, and the generated tool-whitelist sentence is appended to it", () => {
    const { addendum } = spec(parse(CURSOR_FIXTURE));
    expect(addendum).toContain("You are a senior reviewer in a FRESH context");
    expect(addendum).toContain("your only tools this run are: read_file, grep, glob, bash");
    expect(addendum).toContain("cannot dispatch subagents");
  });
});

describe("parseAgentFile — tool grants", () => {
  test("a YAML list and a comma-separated scalar produce the same grant", () => {
    const list = spec(
      parse("---\ndescription: d\ntools:\n  - Read\n  - Grep\n---\nbody\n"),
    ).toolNames;
    const scalar = spec(parse("---\ndescription: d\ntools: Read, Grep\n---\nbody\n")).toolNames;
    expect(list).toEqual(["read_file", "grep"]);
    expect(scalar).toEqual(list);
  });

  test("tool names are case-insensitive across both vocabularies", () => {
    const parsed = spec(parse("---\ndescription: d\ntools: rEaD, WRITE_FILE, bAsH\n---\nb\n"));
    expect(parsed.toolNames).toEqual(["read_file", "write_file", "bash"]);
  });

  test("readonly: true grants exactly the read-only set", () => {
    const parsed = spec(parse("---\ndescription: d\nreadonly: true\n---\nb\n"));
    expect(parsed.toolNames).toEqual([...READ_ONLY_TOOL_NAMES]);
  });

  test("an explicit tools list beats readonly: true", () => {
    const parsed = spec(parse("---\ndescription: d\nreadonly: true\ntools: Bash\n---\nb\n"));
    expect(parsed.toolNames).toEqual(["bash"]);
  });

  test("neither tools nor readonly grants every tool seri has", () => {
    const granted: string[] = [...spec(parse("---\ndescription: d\n---\nb\n")).toolNames];
    expect(granted.sort()).toEqual(Object.keys(toolDefinitions).sort());
  });

  test("an unrecognized entry is dropped with a warning, and the rest of the grant stands", () => {
    const outcome = parse("---\ndescription: d\ntools: Read, WebSearch\n---\nb\n");
    expect(spec(outcome).toolNames).toEqual(["read_file"]);
    expect(outcome.kind === "spec" && outcome.warnings.join(" ")).toContain("WebSearch");
  });

  test("dispatch_subagents named as a tool is dropped, never granted", () => {
    const outcome = parse(`---\ndescription: d\ntools: Read, ${DISPATCH_TOOL_NAME}\n---\nb\n`);
    expect(spec(outcome).toolNames).toEqual(["read_file"]);
    expect(spec(outcome).toolNames).not.toContain(DISPATCH_TOOL_NAME);
    expect(outcome.kind === "spec" && outcome.warnings.join(" ")).toContain(DISPATCH_TOOL_NAME);
  });

  test("a tools key whose every entry is unrecognized skips the file instead of granting them all", () => {
    const outcome = parse(`---\ndescription: d\ntools: ${DISPATCH_TOOL_NAME}\n---\nb\n`);
    expect(outcome.kind).toBe("skipped");
    expect(outcome.kind === "skipped" && outcome.warning).toContain("/agents/reviewer.md");
  });




  test("a bare tools: line skips the file instead of granting every tool", () => {
    const outcome = parse("---\ndescription: d\ntools:\n---\nb\n");
    expect(outcome.kind).toBe("skipped");
    expect(outcome.kind === "skipped" && outcome.warning).toContain(
      "names nothing seri recognises",
    );
  });

  test("duplicate entries collapse to one grant each", () => {
    expect(spec(parse("---\ndescription: d\ntools: Read, read_file\n---\nb\n")).toolNames).toEqual([
      "read_file",
    ]);
  });
});

describe("parseAgentFile — names", () => {
  test("the filename is the default name, lowercased, with .md dropped", () => {
    expect(
      spec(parse("---\ndescription: d\n---\nb\n", { filePath: "/a/Deep-Reviewer.md" })).name,
    ).toBe("deep-reviewer");
  });



  test("an uppercase .MD extension is stripped from the default name", () => {
    expect(spec(parse("---\ndescription: d\n---\nb\n", { filePath: "/a/Reviewer.MD" })).name).toBe(
      "reviewer",
    );
  });

  test("an explicit name wins over the filename", () => {
    expect(
      spec(parse("---\nname: oracle-lite\ndescription: d\n---\nb\n", { filePath: "/a/x.md" })).name,
    ).toBe("oracle-lite");
  });

  test("a reserved name is skipped with a warning naming it", () => {
    const outcome = parse("---\nname: explore\ndescription: d\n---\nb\n", {
      reserved: ["explore"],
    });
    expect(outcome.kind).toBe("skipped");
    expect(outcome.kind === "skipped" && outcome.warning).toContain("explore");
  });

  test("a name outside [a-z0-9][a-z0-9-]* is skipped", () => {
    expect(parse("---\nname: my agent\ndescription: d\n---\nb\n").kind).toBe("skipped");
    expect(parse("---\nname: -leading\ndescription: d\n---\nb\n").kind).toBe("skipped");
    expect(parse("---\nname: has_underscore\ndescription: d\n---\nb\n").kind).toBe("skipped");
  });
});

describe("parseAgentFile — model routing", () => {
  test("a concrete id served by a configured provider becomes a complete pair", () => {
    const parsed = spec(
      parse("---\ndescription: d\nmodel: claude-sonnet-5\n---\nb\n", {
        models: { "claude-sonnet-5": "anthropic" },
      }),
    );
    expect(parsed.request).toEqual({
      model: "claude-sonnet-5",
      provider: "anthropic",
      effort: undefined,
    });
  });

  test("bracket params are stripped from the id and effort= is read out of them", () => {
    const parsed = spec(
      parse("---\ndescription: d\nmodel: claude-sonnet-5[effort=high]\n---\nb\n", {
        models: { "claude-sonnet-5": "anthropic" },
      }),
    );
    expect(parsed.request).toEqual({
      model: "claude-sonnet-5",
      provider: "anthropic",
      effort: "high",
    });
  });

  test("an id the catalog does not carry warns and inherits, never a half pin", () => {
    const outcome = parse("---\ndescription: d\nmodel: made-up-model\n---\nb\n");
    expect(spec(outcome).request).toBeUndefined();
    expect(outcome.kind === "spec" && outcome.warnings.join(" ")).toContain("made-up-model");
  });

  test("model: inherit with no effort leaves the request absent entirely", () => {
    expect(spec(parse("---\ndescription: d\nmodel: inherit\n---\nb\n")).request).toBeUndefined();
  });
});

describe("parseAgentFile — files that do not load", () => {
  test("frontmatter that is not valid YAML is skipped with a warning naming the file", () => {
    const outcome = parse("---\ndescription: [unclosed\n---\nb\n", { filePath: "/a/broken.md" });
    expect(outcome.kind).toBe("skipped");
    expect(outcome.kind === "skipped" && outcome.warning).toContain("/a/broken.md");
  });

  test("a file with no frontmatter fence at all is skipped", () => {
    expect(parse("just a prompt, no fence\n").kind).toBe("skipped");
  });

  test("frontmatter that parses to something other than a mapping is skipped", () => {
    expect(parse("---\n- a\n- b\n---\nbody\n").kind).toBe("skipped");
  });
});

describe("parseAgentFile — a missing description", () => {
  test("loads with a warning rather than skipping, and carries an empty description", () => {
    const outcome = parse("---\nname: quiet\n---\nbody\n");
    expect(spec(outcome).description).toBe("");
    expect(outcome.kind === "spec" && outcome.warnings.join(" ")).toContain("description");
  });
});



describe("parseAgentFile — a very long description", () => {
  test("beyond 500 characters it is truncated, with a warning naming the file", () => {
    const outcome = parse(`---\ndescription: ${"d".repeat(600)}\n---\nb\n`, {
      filePath: "/a/wordy.md",
    });
    expect(spec(outcome).description).toBe("d".repeat(500));
    expect(outcome.kind === "spec" && outcome.warnings.join(" ")).toContain("/a/wordy.md");
  });
});

describe("parseAgentFile — CRLF", () => {
  test("a file written with Windows line endings parses the same as one with LF", () => {
    const lf = "---\nname: r\ndescription: d\ntools: Read\n---\nbody line\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(spec(parse(crlf)).toolNames).toEqual(spec(parse(lf)).toolNames);
    expect(spec(parse(crlf)).description).toBe("d");
  });



  test("a leading UTF-8 BOM does not defeat the frontmatter fence", () => {
    const parsed = spec(parse("﻿---\r\nname: r\r\ndescription: d\r\n---\r\nbody line\r\n"));
    expect(parsed.name).toBe("r");
    expect(parsed.description).toBe("d");
  });
});
