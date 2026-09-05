import { describe, expect, test } from "bun:test";
import { parsePromptChannel } from "../../src/permissions/promptChannel";

describe("parsePromptChannel", () => {
  test("undefined is live", () => {
    expect(parsePromptChannel(undefined)).toBe("live");
  });

  test("live and none are accepted by name", () => {
    expect(parsePromptChannel("live")).toBe("live");
    expect(parsePromptChannel("none")).toBe("none");
  });

  test("anything else is a usage error naming the raw value", () => {
    expect(parsePromptChannel("auto")).toEqual({
      error: "Invalid --permission-prompts value: auto",
    });
    expect(parsePromptChannel("")).toEqual({
      error: "Invalid --permission-prompts value: ",
    });
  });
});
