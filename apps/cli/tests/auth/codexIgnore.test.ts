import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_AUTH_FILENAME } from "../../src/auth/codexAuthStore";
import { disconnectCodex } from "../../src/auth/codexConnect";
import {
  CODEX_IGNORE_FILENAME,
  clearCodexSubscriptionIgnore,
  ignoreCodexSubscription,
  isCodexSubscriptionIgnored,
  reconnectCodex,
} from "../../src/auth/codexIgnore";

describe("codexIgnore", () => {
  let configDir: string;
  let codexHome: string;
  const originalHome = process.env.CODEX_HOME;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "seri-codex-ignore-cfg-"));
    codexHome = mkdtempSync(join(tmpdir(), "seri-codex-ignore-home-"));
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalHome;
    rmSync(configDir, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  });

  test("a missing file is not ignored", () => {
    expect(isCodexSubscriptionIgnored(configDir)).toBe(false);
  });

  test("writing the flag makes the profile ignore the plan", () => {
    ignoreCodexSubscription(configDir);
    expect(existsSync(join(configDir, CODEX_IGNORE_FILENAME))).toBe(true);
    expect(isCodexSubscriptionIgnored(configDir)).toBe(true);
  });

  test("clearing the flag restores the default", () => {
    ignoreCodexSubscription(configDir);
    clearCodexSubscriptionIgnore(configDir);
    expect(isCodexSubscriptionIgnored(configDir)).toBe(false);
    expect(existsSync(join(configDir, CODEX_IGNORE_FILENAME))).toBe(false);
  });

  test("clearing when the file is missing is not an error", () => {
    expect(() => clearCodexSubscriptionIgnore(configDir)).not.toThrow();
  });

  test("disconnectCodex does not write or unlink the Codex CLI auth file", () => {
    const authPath = join(codexHome, CODEX_AUTH_FILENAME);
    const body = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "tok", account_id: "acct" },
    });
    writeFileSync(authPath, body);
    const before = readFileSync(authPath);
    const mtime = statSync(authPath).mtimeMs;

    const messages: string[] = [];
    disconnectCodex(configDir, (message) => messages.push(message));

    expect(isCodexSubscriptionIgnored(configDir)).toBe(true);
    expect(readFileSync(authPath)).toEqual(before);
    expect(statSync(authPath).mtimeMs).toBe(mtime);
    expect(messages.some((line) => /not touched/i.test(line))).toBe(true);
    expect(messages.some((line) => /xAI/i.test(line))).toBe(false);
  });

  test("reconnectCodex clears the ignore and leaves Codex auth untouched", () => {
    const authPath = join(codexHome, CODEX_AUTH_FILENAME);
    writeFileSync(
      authPath,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "tok", account_id: "acct" },
      }),
    );
    const before = readFileSync(authPath);
    ignoreCodexSubscription(configDir);

    const messages: string[] = [];
    reconnectCodex(configDir, (message) => messages.push(message));

    expect(isCodexSubscriptionIgnored(configDir)).toBe(false);
    expect(readFileSync(authPath)).toEqual(before);
    expect(messages).toEqual(["Re-enabled ChatGPT plan for this profile."]);
  });
});
