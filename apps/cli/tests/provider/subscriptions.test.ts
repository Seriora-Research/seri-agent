import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subscribedProviders } from "../../src/provider/subscriptions";

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
});
