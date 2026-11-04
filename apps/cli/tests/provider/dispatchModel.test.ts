import { describe, expect, test } from "bun:test";
import { streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { dispatchModel } from "../../src/provider/model";
import type { ResolvedRoute } from "../../src/provider/routing";
import { streamResult, textOnlyChunks } from "../loop/fixtures";

describe("dispatchModel", () => {
  test("a gateway-credential route dispatches through getGatewayModel, never getModel's provider switch", () => {
    const route: ResolvedRoute = {
      model: "groq/shared-model",
      provider: "openrouter",
      rerouted: false,
      credential: "gateway",
    };
    const fakeModel = {} as ReturnType<typeof dispatchModel>;
    const calls: Array<{ id: string; provider: string; sessionId: string; configDir: string }> = [];
    dispatchModel(route, "test-session-id", "/tmp/config", {
      getGatewayModel: (id, provider, sessionId, configDir) => {
        calls.push({ id, provider, sessionId, configDir });
        return fakeModel;
      },
      getOpenRouterModel: () => {
        throw new Error("should not be called: a gateway route must not reach getModel's switch");
      },
    });
    expect(calls).toEqual([
      {
        id: "groq/shared-model",
        provider: "openrouter",
        sessionId: "test-session-id",
        configDir: "/tmp/config",
      },
    ]);
  });

  test("a non-gateway route still dispatches through getModel's provider switch, unchanged", () => {
    const route: ResolvedRoute = {
      model: "some-id",
      provider: "groq",
      rerouted: false,
      credential: "key",
    };
    const fakeModel = {} as ReturnType<typeof dispatchModel>;
    const calls: string[] = [];
    dispatchModel(route, "test-session-id", "/tmp/config", {
      getGroqModel: (id) => {
        calls.push(id);
        return fakeModel;
      },
      getGatewayModel: () => {
        throw new Error("should not be called: a non-gateway route must not reach getGatewayModel");
      },
    });
    expect(calls).toEqual(["some-id"]);
  });

  test("a dispatched model gives the provider its own abort signal, tied to the caller's", async () => {
    const provider = new MockLanguageModelV4({
      doStream: async () => streamResult(textOnlyChunks("hi")),
    });
    const model = dispatchModel(
      { model: "some-id", provider: "groq", rerouted: false, credential: "key" },
      "test-session-id",
      "/tmp/config",
      { getGroqModel: () => provider },
    );
    const caller = new AbortController();

    await streamText({ model, prompt: "hi", abortSignal: caller.signal }).text;
    const received = provider.doStreamCalls[0]?.abortSignal;

    expect(received).toBeDefined();
    expect(received).not.toBe(caller.signal);
    caller.abort();
    expect(received?.aborted).toBe(true);
  });
});

describe("dispatchModel for a subscription route", () => {
  test("dispatches to the subscription client, never getModel's key switch", () => {
    const calls: string[] = [];
    const fake = {} as ReturnType<typeof dispatchModel>;
    dispatchModel(
      {
        model: "grok-4.5",
        provider: "xai",
        rerouted: false,
        credential: "subscription",
      },
      "session-1",
      "/tmp/cfg",
      {
        getXaiSubscriptionModel: (id) => {
          calls.push(id);
          return fake;
        },
        getXaiModel: () => {
          throw new Error("the key path must not be used for a subscription route");
        },
      },
    );
    expect(calls).toEqual(["grok-4.5"]);
  });

  test("names the provider when a subscription route resolves to one with no subscription client", () => {
    expect(() =>
      dispatchModel(
        {
          model: "claude-haiku-4-5",
          provider: "anthropic",
          rerouted: false,
          credential: "subscription",
        },
        "session-1",
        "/tmp/cfg",
        {},
      ),
    ).toThrow(/No subscription client for provider/);
  });

  test("an openai subscription route dispatches to the Codex client, never getOpenAIModel", () => {
    const calls: string[] = [];
    const fake = {} as ReturnType<typeof dispatchModel>;
    dispatchModel(
      {
        model: "gpt-5.6-terra",
        provider: "openai",
        rerouted: false,
        credential: "subscription",
      },
      "session-1",
      "/tmp/cfg",
      {
        getCodexSubscriptionModel: (id) => {
          calls.push(id);
          return fake;
        },
        getOpenAIModel: () => {
          throw new Error("the key path must not be used for a Codex subscription route");
        },
      },
    );
    expect(calls).toEqual(["gpt-5.6-terra"]);
  });
});
