import { describe, expect, test } from "bun:test";
import { classifyToolCall, parseAutoModeOnBlock } from "../../src/gate/classifier";

describe("parseAutoModeOnBlock", () => {
  test("ask is the only non-default", () => {
    expect(parseAutoModeOnBlock("ask")).toBe("ask");
  });

  test("everything else is deny, including the documented default", () => {
    expect(parseAutoModeOnBlock("deny")).toBe("deny");
    expect(parseAutoModeOnBlock(undefined)).toBe("deny");
    expect(parseAutoModeOnBlock(null)).toBe("deny");
    expect(parseAutoModeOnBlock("ASK")).toBe("deny");
    expect(parseAutoModeOnBlock("prompt")).toBe("deny");
    expect(parseAutoModeOnBlock(1)).toBe("deny");
  });
});

describe("classifyToolCall", () => {
  test("allows every call until a deny-by-default class exists", () => {
    expect(classifyToolCall("bash", { command: "curl 169.254.169.254" })).toEqual({
      kind: "allow",
    });
    expect(classifyToolCall("write_file", { path: "a.txt" })).toEqual({ kind: "allow" });
  });
});
