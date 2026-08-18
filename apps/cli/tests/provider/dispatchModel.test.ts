import { describe, expect, test } from "bun:test";
import { dispatchModel } from "../../src/provider/model";
import type { ResolvedRoute } from "../../src/provider/routing";

// Regression for the gap this PR's own manual e2e testing found live: getGatewayModel
// (provider/gateway.ts) was defined and exported but never called anywhere — resolveRoute could
// set ResolvedRoute.viaGateway: true, but nothing downstream read it, so a gateway-covered route
// always fell through to getModel's provider switch and threw missingKeyError the instant a turn
// ran, instead of actually routing through the gateway.
describe("dispatchModel", () => {
  test("a viaGateway route dispatches through getGatewayModel, never getModel's provider switch", () => {
    const route: ResolvedRoute = {
      model: "groq/shared-model",
      provider: "openrouter",
      rerouted: false,
      viaGateway: true,
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
      viaGateway: false,
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
