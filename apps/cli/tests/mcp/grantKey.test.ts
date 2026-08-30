import { describe, expect, test } from "bun:test";
import { toolFingerprint } from "../../src/mcp/registry";
import type { McpToolInfo } from "../../src/mcp/types";
import { isMcpGrantKey, mcpGrantKey, mcpGrantMatches, parseMcpGrantKey } from "../../src/mcp/types";

function tool(overrides: Partial<McpToolInfo> = {}): McpToolInfo {
  return {
    name: "web_search",
    toolName: "mcp_exa_web_search",
    description: "Search the web.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    ...overrides,
  };
}

describe("mcpGrantKey", () => {
  test("composes the tool name and a truncated digest", () => {
    const key = mcpGrantKey("mcp_exa_web_search", toolFingerprint(tool()));
    expect(key).toBe(`mcp_exa_web_search@${toolFingerprint(tool()).slice(0, 12)}`);
  });
});

describe("parseMcpGrantKey", () => {
  test("recovers the tool name and fingerprint from a valid key", () => {
    expect(parseMcpGrantKey("mcp_exa_web_search@a1b2c3d4e5f6")).toEqual({
      toolName: "mcp_exa_web_search",
      fingerprint: "a1b2c3d4e5f6",
    });
  });

  test("round-trips through mcpGrantKey", () => {
    const fingerprint = toolFingerprint(tool());
    const key = mcpGrantKey("mcp_exa_web_search", fingerprint);
    expect(parseMcpGrantKey(key)).toEqual({
      toolName: "mcp_exa_web_search",
      fingerprint: fingerprint.slice(0, 12),
    });
  });

  test("undefined for a built-in name, which is how it passes through untouched", () => {
    expect(parseMcpGrantKey("write_file")).toBeUndefined();
    expect(parseMcpGrantKey("edit")).toBeUndefined();
  });

  test("undefined for a malformed digest — too short", () => {
    expect(parseMcpGrantKey("mcp_exa_web_search@short")).toBeUndefined();
  });

  test("undefined for a malformed digest — non-hex characters", () => {
    expect(parseMcpGrantKey("mcp_exa_web_search@zzzzzzzzzzzz")).toBeUndefined();
  });

  test("undefined for a name with no @ at all", () => {
    expect(parseMcpGrantKey("mcp_exa_web_search")).toBeUndefined();
  });
});

describe("isMcpGrantKey", () => {
  test("true for a validly-shaped key", () => {
    expect(isMcpGrantKey("mcp_exa_web_search@a1b2c3d4e5f6")).toBe(true);
  });

  test("false for a built-in name", () => {
    expect(isMcpGrantKey("write_file")).toBe(false);
  });

  test("false for a malformed digest", () => {
    expect(isMcpGrantKey("mcp_exa_web_search@nothex")).toBe(false);
  });
});

describe("mcpGrantMatches", () => {
  test("true for the same contract", () => {
    const a = tool();
    const key = mcpGrantKey(a.toolName, toolFingerprint(a));
    expect(mcpGrantMatches(key, toolFingerprint(a))).toBe(true);
  });

  test("false after the tool's description changes on the server", () => {
    const before = tool({ description: "Search the web." });
    const after = tool({ description: "Search the web, differently." });
    const key = mcpGrantKey(before.toolName, toolFingerprint(before));
    expect(mcpGrantMatches(key, toolFingerprint(after))).toBe(false);
  });

  test("false for an entry that is not a valid grant key at all", () => {
    expect(mcpGrantMatches("write_file", toolFingerprint(tool()))).toBe(false);
  });
});
