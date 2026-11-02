import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { McpEndpoint, mcpLine } from "../../src/mcp/endpoint";

const WIRE = "https://user:pw@host/mcp?token=SECRET";
const DISPLAY = "https://host/mcp?token=REDACTED";

describe("McpEndpoint", () => {
  test("wireHref keeps the configured url and display forms do not", () => {
    const endpoint = McpEndpoint.tryParse(WIRE);
    expect(endpoint).toBeDefined();
    if (endpoint === undefined) return;
    expect(endpoint.wireHref()).toBe(WIRE);
    expect(endpoint.wireHref()).toContain("SECRET");
    expect(endpoint.wireHref()).toContain("pw");
    expect(String(endpoint)).toBe(DISPLAY);
    expect(JSON.stringify(endpoint)).toContain(DISPLAY);
    expect(JSON.stringify(endpoint)).not.toContain("SECRET");
    expect(JSON.stringify(endpoint)).not.toContain("pw");
    expect(inspect(endpoint)).toContain(DISPLAY);
    expect(inspect(endpoint)).not.toContain("SECRET");
    expect(inspect(endpoint)).not.toContain("pw");
    expect(String(mcpLine`${endpoint}`)).toBe(DISPLAY);
  });

  test("a non-default port stays in the displayed url", () => {
    const raw = "https://user:pw@host:443/mcp?token=SECRET";
    const endpoint = McpEndpoint.tryParse(raw);
    expect(endpoint).toBeDefined();
    if (endpoint === undefined) return;
    expect(endpoint.wireHref()).toBe(raw);
    expect(String(endpoint)).toBe("https://host:443/mcp?token=REDACTED");
  });

  test("a query value that contains @ is redacted whole, not split as userinfo", () => {
    const endpoint = McpEndpoint.tryParse("https://host/mcp?note=a@b");
    expect(endpoint).toBeDefined();
    if (endpoint === undefined) return;
    expect(String(endpoint)).toBe("https://host/mcp?note=REDACTED");
    expect(endpoint.wireHref()).toBe("https://host/mcp?note=a@b");
  });
});

describe("mcpLine", () => {
  test("a credential url loses its userinfo and query value", () => {
    const line = mcpLine`${WIRE}`;
    expect(line).not.toContain("pw");
    expect(line).not.toContain("SECRET");
    expect(line).toContain(DISPLAY);
  });

  test("an unparseable line still loses a recognizable query token", () => {
    const line = mcpLine`not a url ?token=SECRET`;
    expect(String(line)).toBe("not a url ?token=REDACTED");
    expect(line).not.toContain("SECRET");
  });

  test("a query @ is not treated as userinfo", () => {
    const line = mcpLine`https://host/mcp?note=a@b`;
    expect(String(line)).toBe("https://host/mcp?note=REDACTED");
    expect(line).not.toContain("a@b");
  });

  test("a secret outside a query span stays", () => {
    const line = mcpLine`not a url ?token=SECRET and also SECRET`;
    expect(String(line)).toBe("not a url ?token=REDACTED and also SECRET");
  });

  test("userinfo, empty values, flags, and fragments keep their own rules", () => {
    const line = mcpLine`https://user:pw@host/mcp?token=SECRET&empty=&flag#keep`;
    expect(String(line)).toBe("https://host/mcp?token=REDACTED&empty=&flag#keep");
  });
});
