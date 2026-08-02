import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../../src/config/paths";

const originalPlatform = process.platform;
const originalLocalAppData = process.env.LOCALAPPDATA;

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform });
}

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

afterEach(() => {
  setPlatform(originalPlatform);
  restoreEnv("LOCALAPPDATA", originalLocalAppData);
});

describe("getConfigDir", () => {
  test("win32 with LOCALAPPDATA set returns joined path", () => {
    setPlatform("win32");
    process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
    expect(getConfigDir()).toBe(join("C:\\Users\\test\\AppData\\Local", "hesper"));
  });

  test("win32 without LOCALAPPDATA throws", () => {
    setPlatform("win32");
    delete process.env.LOCALAPPDATA;
    expect(() => getConfigDir()).toThrow();
  });

  test("posix returns ~/.hesper", () => {
    setPlatform("linux");
    expect(getConfigDir()).toBe(join(homedir(), ".hesper"));
  });
});
