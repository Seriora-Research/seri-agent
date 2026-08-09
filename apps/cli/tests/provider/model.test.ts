import { describe, expect, test } from "bun:test";
import { getModel } from "../../src/provider/model";

describe("getModel", () => {
  test("dispatches to getGroqModel for provider: groq", () => {
    const calls: string[] = [];
    const fakeGroqModel = {} as ReturnType<typeof getModel>;
    const model = getModel("some-id", "groq", {
      getGroqModel: (id) => {
        calls.push(id);
        return fakeGroqModel;
      },
      getOpenRouterModel: () => {
        throw new Error("should not be called");
      },
    });
    expect(model).toBe(fakeGroqModel);
    expect(calls).toEqual(["some-id"]);
  });

  test("dispatches to getOpenRouterModel for provider: openrouter", () => {
    const calls: string[] = [];
    const fakeOpenRouterModel = {} as ReturnType<typeof getModel>;
    const model = getModel("some-id", "openrouter", {
      getGroqModel: () => {
        throw new Error("should not be called");
      },
      getOpenRouterModel: (id) => {
        calls.push(id);
        return fakeOpenRouterModel;
      },
    });
    expect(model).toBe(fakeOpenRouterModel);
    expect(calls).toEqual(["some-id"]);
  });
});
