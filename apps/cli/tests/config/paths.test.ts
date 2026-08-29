import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { AUTH_FILENAME } from "../../src/auth/authStore";
import { CONFIG_FILENAME } from "../../src/config/config";
import {
  DATABASE_FILENAME,
  DAEMON_DESCRIPTOR_FILENAME,
  DAEMON_LOCK_FILENAME,
  DEFAULT_PROFILE,
  getBaseConfigDir,
  getConfigDir,
  getDatabasePath,
  getDaemonDescriptorPath,
  getDaemonLockPath,
  getMemoriesDir,
  getPendingDir,
  getTrajectoriesDir,
  getReservedProfileNames,
  profileNameError,
  resolveProfile,
  setProfileOverride,
} from "../../src/config/paths";
import { PERMISSIONS_FILENAME } from "../../src/permissions/store";

const originalPlatform = process.platform;
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
  restoreEnv("HOME", originalHome);
  restoreEnv("SERI_PROFILE", originalSeriProfile);
  setProfileOverride(undefined);
});

describe("getBaseConfigDir", () => {
  // getBaseConfigDir() has no win32 branch — these pin platform-*independence* (win32 must
  // resolve identically to posix), not a Windows-specific code path.
  test("win32 with HOME set returns joined path", () => {
    setPlatform("win32");
    process.env.HOME = "C:\\Users\\test";
    expect(getBaseConfigDir()).toBe(join("C:\\Users\\test", ".seri"));
  });

  // homedir() is read here, after HOME is deleted, not captured beforehand: Bun/Node's os.homedir()
  // consults $HOME first on POSIX, so a value captured before the delete would not reflect the
  // fallback this asserts.
  test("win32 without HOME falls back to homedir()", () => {
    setPlatform("win32");
    delete process.env.HOME;
    expect(getBaseConfigDir()).toBe(join(homedir(), ".seri"));
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

  // A differently-cased "default" must resolve identically to profileNameError's own fold —
  // otherwise it passes validation (DEFAULT_PROFILE is never reserved) and then silently creates a
  // real, separate "Default/" directory instead of being treated as the default profile.
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
  // Iterating the returned set is what makes THIS test grow with it, so a name added later needs
  // no update here — but it alone would not catch an existing entry being dropped from the set
  // (the iteration just shrinks with it), which is what the exact-list assertion below is for.
  test("every reserved name is rejected", () => {
    for (const name of getReservedProfileNames()) expect(profileNameError(name)).toBeDefined();
  });

  // Pinned against the literal expected membership, not derived from getReservedProfileNames()
  // itself: the three file names are read from the module that actually writes each file, so a
  // real desync between paths.ts's reserved set and what config.ts/authStore.ts/store.ts write
  // would fail here; the four directory names (no single owning file) are hardcoded literals, so
  // an accidental deletion from the reserved set — permissions.yaml or bin included — turns this
  // test red instead of silently shrinking the set the iteration test above checks.
  test("the reserved set is exactly the file and directory names it collides with", () => {
    const expected = [
      CONFIG_FILENAME,
      AUTH_FILENAME,
      PERMISSIONS_FILENAME,
      "sessions",
      "checkpoints",
      "rg",
      "bin",
      "agents",
      "memories",
      "pending",
      "trajectories",
      DATABASE_FILENAME,
      DAEMON_DESCRIPTOR_FILENAME,
      DAEMON_LOCK_FILENAME,
    ];
    expect([...getReservedProfileNames()].sort()).toEqual([...expected].sort());
  });

  // Stage 6b: memories/ and pending/ join the reserved set the same way sessions/checkpoints did.
  test.each(["agents", "memories", "pending", "trajectories"])("%s is reserved", (name) => {
    expect(profileNameError(name)).toBeDefined();
  });

  test.each(["Memories", "Pending"])("%s is reserved case-folded on win32/darwin", (name) => {
    setPlatform("win32");
    expect(profileNameError(name)).toBeDefined();
    setPlatform("darwin");
    expect(profileNameError(name)).toBeDefined();
  });

  // Case-folding is platform-conditional (win32/darwin only), matching the one existing precedent
  // for this exact decision (permissions/store.ts's projectKey, checkpoint.ts's foldsCase) — not
  // set via setPlatform, this would silently pass or fail depending on which OS runs the suite.
  test("reserved names are rejected case-folded on win32", () => {
    setPlatform("win32");
    expect(profileNameError("Sessions")).toBeDefined();
  });

  test("reserved names are rejected case-folded on darwin", () => {
    setPlatform("darwin");
    expect(profileNameError("Sessions")).toBeDefined();
  });

  // The negative control for the two tests above: ext4 is case-sensitive, so "Sessions" and
  // "sessions" are genuinely different directories on Linux and must not both be rejected.
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

  // Empty string reads as unset, matching config.ts's own deliberate `||`.
  test("an empty SERI_PROFILE reads as unset", () => {
    process.env.SERI_PROFILE = "";
    expect(resolveProfile(undefined)).toEqual({ profile: DEFAULT_PROFILE, source: "default" });
  });

  test("no flag and no SERI_PROFILE resolves to default", () => {
    delete process.env.SERI_PROFILE;
    expect(resolveProfile(undefined)).toEqual({ profile: DEFAULT_PROFILE, source: "default" });
  });

  // `seri --profile "$UNSET_VAR" …` is a real shell pattern that expands to an explicit empty
  // string. It must fall through the same way SERI_PROFILE="" already does above, not surface as
  // an explicit flag value that then fails profileNameError's charset check.
  test("an empty --profile flag reads as unset, same as an empty SERI_PROFILE", () => {
    delete process.env.SERI_PROFILE;
    expect(resolveProfile("")).toEqual({ profile: DEFAULT_PROFILE, source: "default" });
  });

  test("an empty --profile flag still falls through to SERI_PROFILE", () => {
    process.env.SERI_PROFILE = "envd";
    expect(resolveProfile("")).toEqual({ profile: "envd", source: "env" });
  });
});

describe("getMemoriesDir / getPendingDir / getTrajectoriesDir", () => {
  test("join under getConfigDir() by default", () => {
    setPlatform("linux");
    process.env.HOME = "/home/test";
    expect(getMemoriesDir()).toBe(join(getConfigDir(), "memories"));
    expect(getPendingDir()).toBe(join(getConfigDir(), "pending"));
    expect(getTrajectoriesDir()).toBe(join(getConfigDir(), "trajectories"));
    expect(getDatabasePath()).toBe(join(getConfigDir(), DATABASE_FILENAME));
    expect(getDaemonDescriptorPath()).toBe(join(getConfigDir(), DAEMON_DESCRIPTOR_FILENAME));
    expect(getDaemonLockPath()).toBe(join(getConfigDir(), DAEMON_LOCK_FILENAME));
  });

  test("honour an explicit configDir argument", () => {
    expect(getMemoriesDir("/tmp/some-dir")).toBe(join("/tmp/some-dir", "memories"));
    expect(getPendingDir("/tmp/some-dir")).toBe(join("/tmp/some-dir", "pending"));
    expect(getTrajectoriesDir("/tmp/some-dir")).toBe(join("/tmp/some-dir", "trajectories"));
    expect(getDatabasePath("/tmp/some-dir")).toBe(join("/tmp/some-dir", DATABASE_FILENAME));
    expect(getDaemonDescriptorPath("/tmp/some-dir")).toBe(
      join("/tmp/some-dir", DAEMON_DESCRIPTOR_FILENAME),
    );
    expect(getDaemonLockPath("/tmp/some-dir")).toBe(join("/tmp/some-dir", DAEMON_LOCK_FILENAME));
  });
});
