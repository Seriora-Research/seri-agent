import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PROFILE,
  RESERVED_PROFILE_NAMES,
  getBaseConfigDir,
  getConfigDir,
  profileNameError,
  resolveProfile,
  setProfileOverride,
} from "../../src/config/paths";

const originalPlatform = process.platform;
const originalLocalAppData = process.env.LOCALAPPDATA;
const originalHome = process.env.HOME;
const originalSeriProfile = process.env.SERI_PROFILE;

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform });
}

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

// A leaked override or a developer's own SERI_PROFILE would otherwise mask every assertion below —
// same rule as the cross-platform env-var-dependent code guidance in code-quality.md.
afterEach(() => {
  setPlatform(originalPlatform);
  restoreEnv("LOCALAPPDATA", originalLocalAppData);
  restoreEnv("HOME", originalHome);
  restoreEnv("SERI_PROFILE", originalSeriProfile);
  setProfileOverride(undefined);
});

describe("getBaseConfigDir", () => {
  test("win32 with LOCALAPPDATA set returns joined path", () => {
    setPlatform("win32");
    process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
    expect(getBaseConfigDir()).toBe(join("C:\\Users\\test\\AppData\\Local", "seri"));
  });

  // The documented fallback (D2): getConfigDir() delegates, so it throws too.
  test("win32 without LOCALAPPDATA throws", () => {
    setPlatform("win32");
    delete process.env.LOCALAPPDATA;
    expect(() => getBaseConfigDir()).toThrow();
    expect(() => getConfigDir()).toThrow();
  });

  test("posix with HOME set returns joined path", () => {
    setPlatform("linux");
    process.env.HOME = "/home/test";
    expect(getBaseConfigDir()).toBe(join("/home/test", ".seri"));
  });

  // homedir() is read here, after HOME is deleted, not captured beforehand: Bun/Node's os.homedir()
  // consults $HOME first on POSIX, so a value captured before the delete would not reflect the
  // fallback this asserts.
  test("posix without HOME falls back to homedir()", () => {
    setPlatform("linux");
    delete process.env.HOME;
    expect(getBaseConfigDir()).toBe(join(homedir(), ".seri"));
  });

  test("is unchanged by SERI_PROFILE and by setProfileOverride", () => {
    setPlatform("linux");
    process.env.HOME = "/home/test";
    const base = getBaseConfigDir();

    process.env.SERI_PROFILE = "work";
    setProfileOverride("work");

    expect(getBaseConfigDir()).toBe(base);
  });
});

describe("getConfigDir default-profile identity", () => {
  test("with nothing set, equals getBaseConfigDir()", () => {
    setPlatform("linux");
    process.env.HOME = "/home/test";
    expect(getConfigDir()).toBe(getBaseConfigDir());
  });

  // Today's literal per-profile leaf paths — built from getBaseConfigDir(), not a hardcoded
  // ".seri" — must not move under the default profile.
  test("each per-profile leaf path equals today's literal value", () => {
    setPlatform("linux");
    process.env.HOME = "/home/test";
    const base = getBaseConfigDir();

    for (const leaf of ["config.json", "auth.json", "permissions.yaml", "sessions", "checkpoints"]) {
      expect(join(getConfigDir(), leaf)).toBe(join(base, leaf));
    }
  });

  test("explicit default profile (override and env) resolves to the base, no default/ segment", () => {
    setPlatform("linux");
    process.env.HOME = "/home/test";
    const base = getBaseConfigDir();

    setProfileOverride("default");
    expect(getConfigDir()).toBe(base);

    setProfileOverride(undefined);
    process.env.SERI_PROFILE = "default";
    expect(getConfigDir()).toBe(base);
  });
});

describe("getConfigDir disjointness", () => {
  test("a non-default profile resolves under base/<profile>", () => {
    setPlatform("linux");
    process.env.HOME = "/home/test";
    setProfileOverride("work");
    expect(getConfigDir()).toBe(join(getBaseConfigDir(), "work"));
  });

  test("a non-default profile's five paths are disjoint from the default's", () => {
    setPlatform("linux");
    process.env.HOME = "/home/test";
    const base = getBaseConfigDir();

    for (const leaf of ["config.json", "auth.json", "permissions.yaml", "sessions", "checkpoints"]) {
      const defaultPath = join(base, leaf);
      setProfileOverride("work");
      const workPath = join(getConfigDir(), leaf);
      setProfileOverride(undefined);

      expect(workPath).not.toBe(defaultPath);
      expect(workPath.startsWith(defaultPath)).toBe(false);
      expect(defaultPath.startsWith(workPath)).toBe(false);
    }
  });

  test("rg/ resolves identically under both profiles and is not under the profile root", () => {
    setPlatform("linux");
    process.env.HOME = "/home/test";
    const base = getBaseConfigDir();
    const rgDefault = join(base, "rg");

    setProfileOverride("work");
    const rgUnderWork = join(getBaseConfigDir(), "rg");
    const workRoot = getConfigDir();

    expect(rgUnderWork).toBe(rgDefault);
    expect(rgUnderWork.startsWith(workRoot)).toBe(false);
  });
});

describe("profileNameError", () => {
  // Iterating the exported set is what makes this test grow with it, so a name added later needs
  // no test update. It alone would not catch an existing entry being dropped from the set (the
  // iteration just shrinks with it), which is what the explicit membership checks below are for —
  // permissions and bin were the two the call-site sweep could not see on its own (see
  // feature-plan.md's "why seven, not six").
  test("every reserved name is rejected", () => {
    for (const name of RESERVED_PROFILE_NAMES) expect(profileNameError(name)).toBeDefined();
  });

  test("permissions and bin are reserved", () => {
    expect(RESERVED_PROFILE_NAMES.has("permissions")).toBe(true);
    expect(RESERVED_PROFILE_NAMES.has("bin")).toBe(true);
  });

  test("reserved names are rejected case-folded", () => {
    expect(profileNameError("Sessions")).toBeDefined();
  });

  test.each(["../evil", "..", ".", "a/b", "a\\b", ""])("%p is rejected", (name) => {
    expect(profileNameError(name)).toBeDefined();
  });

  test.each(["work", "personal-2", "a.b_c", "default"])("%p is valid", (name) => {
    expect(profileNameError(name)).toBeUndefined();
  });
});

describe("resolveProfile precedence (D1)", () => {
  test("--profile wins over SERI_PROFILE", () => {
    process.env.SERI_PROFILE = "envd";
    expect(resolveProfile("flagged")).toEqual({ profile: "flagged", source: "flag" });
  });

  test("SERI_PROFILE is used when no flag is given", () => {
    process.env.SERI_PROFILE = "envd";
    expect(resolveProfile(undefined)).toEqual({ profile: "envd", source: "env" });
  });

  // Empty string reads as unset, matching config.ts's own deliberate `||`.
  test("an empty SERI_PROFILE reads as unset", () => {
    process.env.SERI_PROFILE = "";
    expect(resolveProfile(undefined)).toEqual({ profile: DEFAULT_PROFILE, source: "default" });
  });

  test("no flag and no SERI_PROFILE resolves to default", () => {
    delete process.env.SERI_PROFILE;
    expect(resolveProfile(undefined)).toEqual({ profile: DEFAULT_PROFILE, source: "default" });
  });
});
