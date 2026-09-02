import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCodexSubscriptionIgnore, ignoreCodexSubscription } from "../../src/auth/codexIgnore";
import { saveXaiSubscription } from "../../src/auth/xaiAuthStore";
import {
  modelPickerSubscribedProviders,
  subscribedProviders,
} from "../../src/provider/subscriptions";

describe("subscribedProviders includes openai for a Codex chatgpt login", () => {
  let home: string;
  let configDir: string;
  const original = process.env.CODEX_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "seri-codex-sub-"));
    configDir = mkdtempSync(join(tmpdir(), "seri-cfg-"));
    process.env.CODEX_HOME = home;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = original;
    rmSync(home, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  test("an API-key Codex login does not add openai", () => {
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test" }),
    );
    expect(subscribedProviders(configDir).has("openai")).toBe(false);
  });

  test("a chatgpt login adds openai", () => {
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "tok", account_id: "acct" },
      }),
    );
    expect(subscribedProviders(configDir).has("openai")).toBe(true);
  });

  test("a chatgpt login with a profile ignore does not add openai", () => {
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "tok", account_id: "acct" },
      }),
    );
    ignoreCodexSubscription(configDir);
    expect(subscribedProviders(configDir).has("openai")).toBe(false);
  });

  test("clearing the ignore restores openai in the subscribed set", () => {
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "tok", account_id: "acct" },
      }),
    );
    ignoreCodexSubscription(configDir);
    expect(subscribedProviders(configDir).has("openai")).toBe(false);
    clearCodexSubscriptionIgnore(configDir);
    expect(subscribedProviders(configDir).has("openai")).toBe(true);
  });

  test("a persisted Grok grant adds xai", () => {
    saveXaiSubscription(
      {
        accessToken: "a",
        refreshToken: "r",
        obtainedAt: new Date().toISOString(),
        accountId: "acct-1",
      },
      configDir,
    );
    expect(subscribedProviders(configDir).has("xai")).toBe(true);
  });
});

describe("modelPickerSubscribedProviders", () => {
  let home: string;
  let configDir: string;
  const original = process.env.CODEX_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "seri-picker-sub-"));
    configDir = mkdtempSync(join(tmpdir(), "seri-cfg-"));
    process.env.CODEX_HOME = home;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = original;
    rmSync(home, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  test("a persisted Grok grant is in the picker set even when the Codex overlay is off", () => {
    saveXaiSubscription(
      {
        accessToken: "a",
        refreshToken: "r",
        obtainedAt: new Date().toISOString(),
        accountId: "acct-1",
      },
      configDir,
    );
    expect(modelPickerSubscribedProviders(configDir, false).has("xai")).toBe(true);
    expect(modelPickerSubscribedProviders(configDir, false).has("openai")).toBe(false);
  });

  test("a chatgpt login is omitted from the picker set until the overlay is applied", () => {
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "tok", account_id: "acct" },
      }),
    );
    expect(subscribedProviders(configDir).has("openai")).toBe(true);
    expect(modelPickerSubscribedProviders(configDir, false).has("openai")).toBe(false);
    expect(modelPickerSubscribedProviders(configDir, true).has("openai")).toBe(true);
  });
});
