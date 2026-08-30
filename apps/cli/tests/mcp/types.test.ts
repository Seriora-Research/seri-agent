import { describe, expect, test } from "bun:test";
import { isMcpToolName, mcpToolName } from "../../src/mcp/types";

describe("mcpToolName", () => {
  test("folds hyphens in the server name to underscores", () => {
    expect(mcpToolName("my-server", "x")).toBe("mcp_my_server_x");
  });

  test("composes an unhyphenated server name unchanged", () => {
    expect(mcpToolName("exa", "web_search")).toBe("mcp_exa_web_search");
  });
});

describe("isMcpToolName", () => {
  test("true for the mcp_ prefix", () => {
    expect(isMcpToolName("mcp_exa_web_search")).toBe(true);
  });

  test("false for a built-in tool name", () => {
    expect(isMcpToolName("bash")).toBe(false);
  });
});
