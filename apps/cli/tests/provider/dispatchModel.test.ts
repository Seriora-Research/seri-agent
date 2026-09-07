import { describe, expect, test } from "bun:test";
import { dispatchModel } from "../../src/provider/model";
import type { ResolvedRoute } from "../../src/provider/routing";

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
    const model = dispatchModel(route, "test-session-id", "/tmp/config", {
      getGatewayModel: (id, provider, sessionId, configDir) => {
        calls.push({ id, provider, sessionId, configDir });
        return fakeModel;
      },
      getOpenRouterModel: () => {
        throw new Error("should not be called: a gateway route must not reach getModel's switch");
      },
    });
    expect(model).toBe(fakeModel);
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
    const model = dispatchModel(route, "test-session-id", "/tmp/config", {
      getGroqModel: () => fakeModel,
      getGatewayModel: () => {
        throw new Error("should not be called: a non-gateway route must not reach getGatewayModel");
      },
    });
    expect(model).toBe(fakeModel);
  });
});

describe("dispatchModel for a subscription route", () => {
  test("dispatches to the subscription client, never getModel's key switch", () => {
    const calls: string[] = [];
    const fake = {} as ReturnType<typeof dispatchModel>;
    const model = dispatchModel(
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
    expect(model).toBe(fake);
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
    const model = dispatchModel(
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
    expect(model).toBe(fake);
    expect(calls).toEqual(["gpt-5.6-terra"]);
  });
});
