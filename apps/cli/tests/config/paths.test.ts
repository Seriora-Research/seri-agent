import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { AUTH_FILENAME } from "../../src/auth/authStore";
import { CODEX_SERI_AUTH_FILENAME } from "../../src/auth/codexAuthStore";
import { CODEX_IGNORE_FILENAME } from "../../src/auth/codexIgnore";
import { CONFIG_FILENAME } from "../../src/config/config";
import {
  DAEMON_DESCRIPTOR_FILENAME,
  DAEMON_LOCK_FILENAME,
  DATABASE_FILENAME,
  DEFAULT_PROFILE,
  getBaseConfigDir,
  getConfigDir,
  getDaemonDescriptorPath,
  getDaemonLockPath,
  getDatabasePath,
  getMemoriesDir,
  getPendingDir,
  getPlansDir,
  getReservedProfileNames,
  getTrajectoriesDir,
  profileNameError,
  resolveProfile,
  setProfileOverride,
} from "../../src/config/paths";
import { PERMISSIONS_FILENAME } from "../../src/permissions/store";

const originalPlatform = process.platform;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalSeriProfile = process.env.SERI_PROFILE;

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform });
}

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}



afterEach(() => {
  setPlatform(originalPlatform);
  restoreEnv("HOME", originalHome);
  restoreEnv("USERPROFILE", originalUserProfile);
  restoreEnv("SERI_PROFILE", originalSeriProfile);
  setProfileOverride(undefined);
});

describe("getBaseConfigDir", () => {
  test("win32 with HOME set returns joined path", () => {
    setPlatform("win32");
    process.env.HOME = "C:\\Users\\test";
    expect(getBaseConfigDir()).toBe(join("C:\\Users\\test", ".seri"));
  });

  test("win32 with a POSIX HOME uses USERPROFILE", () => {
    setPlatform("win32");
    process.env.HOME = "/c/Users/dest";
    process.env.USERPROFILE = "C:\\Users\\dest";
    expect(getBaseConfigDir()).toBe(join("C:\\Users\\dest", ".seri"));
  });

  test("win32 with HOME=/home/user uses USERPROFILE", () => {
    setPlatform("win32");
    process.env.HOME = "/home/user";
    process.env.USERPROFILE = "C:\\Users\\dest";
    expect(getBaseConfigDir()).toBe(join("C:\\Users\\dest", ".seri"));
  });




  test("win32 without HOME falls back to homedir()", () => {
    setPlatform("win32");
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    expect(getBaseConfigDir()).toBe(join(homedir(), ".seri"));
  });

  test("posix with HOME set returns joined path", () => {
    setPlatform("linux");
    process.env.HOME = "/home/test";
    expect(getBaseConfigDir()).toBe(join("/home/test", ".seri"));
  });




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



  test("each per-profile leaf path equals today's literal value", () => {
    setPlatform("linux");
    process.env.HOME = "/home/test";
    const base = getBaseConfigDir();

    for (const leaf of [
      "config.json",
      "auth.json",
      "permissions.yaml",
      "sessions",
      "checkpoints",
    ]) {
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




  test("a differently-cased default profile folds on win32, stays distinct on linux", () => {
    setPlatform("win32");
    process.env.HOME = "C:\\Users\\test";
    setProfileOverride("Default");
    expect(getConfigDir()).toBe(getBaseConfigDir());

    setPlatform("linux");
    process.env.HOME = "/home/test";
    setProfileOverride("Default");
    expect(getConfigDir()).toBe(join(getBaseConfigDir(), "Default"));
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

    for (const leaf of [
      "config.json",
      "auth.json",
      "permissions.yaml",
      "sessions",
      "checkpoints",
    ]) {
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



  test("every reserved name is rejected", () => {
    for (const name of getReservedProfileNames()) expect(profileNameError(name)).toBeDefined();
  });







  test("the reserved set is exactly the file and directory names it collides with", () => {
    const expected = [
      CONFIG_FILENAME,
      AUTH_FILENAME,
      PERMISSIONS_FILENAME,
      CODEX_IGNORE_FILENAME,
      CODEX_SERI_AUTH_FILENAME,
      "sessions",
      "checkpoints",
      "rg",
      "bin",
      "agents",
      "skills",
      "rules",
      "mcp",
      "hooks",
      "memories",
      "pending",
      "trajectories",
      "plans",
      DATABASE_FILENAME,
      DAEMON_DESCRIPTOR_FILENAME,
      DAEMON_LOCK_FILENAME,
    ];
    expect([...getReservedProfileNames()].sort()).toEqual([...expected].sort());
  });


  test.each([
    "agents",
    "skills",
    "rules",
    "mcp",
    "hooks",
    "memories",
    "pending",
    "trajectories",
    "plans",
  ])("%s is reserved", (name) => {
    expect(profileNameError(name)).toBeDefined();
  });

  test.each(["Memories", "Pending"])("%s is reserved case-folded on win32/darwin", (name) => {
    setPlatform("win32");
    expect(profileNameError(name)).toBeDefined();
    setPlatform("darwin");
    expect(profileNameError(name)).toBeDefined();
  });




  test("reserved names are rejected case-folded on win32", () => {
    setPlatform("win32");
    expect(profileNameError("Sessions")).toBeDefined();
  });

  test("reserved names are rejected case-folded on darwin", () => {
    setPlatform("darwin");
    expect(profileNameError("Sessions")).toBeDefined();
  });



  test("a differently-cased name is valid on linux", () => {
    setPlatform("linux");
    expect(profileNameError("Sessions")).toBeUndefined();
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


  test("an empty SERI_PROFILE reads as unset", () => {
    process.env.SERI_PROFILE = "";
    expect(resolveProfile(undefined)).toEqual({ profile: DEFAULT_PROFILE, source: "default" });
  });

  test("no flag and no SERI_PROFILE resolves to default", () => {
    delete process.env.SERI_PROFILE;
    expect(resolveProfile(undefined)).toEqual({ profile: DEFAULT_PROFILE, source: "default" });
  });




  test("an empty --profile flag reads as unset, same as an empty SERI_PROFILE", () => {
    delete process.env.SERI_PROFILE;
    expect(resolveProfile("")).toEqual({ profile: DEFAULT_PROFILE, source: "default" });
  });

  test("an empty --profile flag still falls through to SERI_PROFILE", () => {
    process.env.SERI_PROFILE = "envd";
    expect(resolveProfile("")).toEqual({ profile: "envd", source: "env" });
  });
});

describe("getMemoriesDir / getPendingDir / getTrajectoriesDir / getPlansDir", () => {
  test("join under getConfigDir() by default", () => {
    setPlatform("linux");
    process.env.HOME = "/home/test";
    expect(getMemoriesDir()).toBe(join(getConfigDir(), "memories"));
    expect(getPendingDir()).toBe(join(getConfigDir(), "pending"));
    expect(getTrajectoriesDir()).toBe(join(getConfigDir(), "trajectories"));
    expect(getPlansDir()).toBe(join(getConfigDir(), "plans"));
    expect(getDatabasePath()).toBe(join(getConfigDir(), DATABASE_FILENAME));
    expect(getDaemonDescriptorPath()).toBe(join(getConfigDir(), DAEMON_DESCRIPTOR_FILENAME));
    expect(getDaemonLockPath()).toBe(join(getConfigDir(), DAEMON_LOCK_FILENAME));
  });

  test("honour an explicit configDir argument", () => {
    expect(getMemoriesDir("/tmp/some-dir")).toBe(join("/tmp/some-dir", "memories"));
    expect(getPendingDir("/tmp/some-dir")).toBe(join("/tmp/some-dir", "pending"));
    expect(getTrajectoriesDir("/tmp/some-dir")).toBe(join("/tmp/some-dir", "trajectories"));
    expect(getPlansDir("/tmp/some-dir")).toBe(join("/tmp/some-dir", "plans"));
    expect(getDatabasePath("/tmp/some-dir")).toBe(join("/tmp/some-dir", DATABASE_FILENAME));
    expect(getDaemonDescriptorPath("/tmp/some-dir")).toBe(
      join("/tmp/some-dir", DAEMON_DESCRIPTOR_FILENAME),
    );
    expect(getDaemonLockPath("/tmp/some-dir")).toBe(join("/tmp/some-dir", DAEMON_LOCK_FILENAME));
  });
});
