import { describe, expect, test } from "bun:test";
import {
  BANG_REFUSED_REASON,
  formatSandboxDoctorDetail,
  formatSandboxIndicator,
  idleSandboxTier,
  parseBangLine,
  resolveShellLaunch,
  type SandboxPolicy,
} from "../../src/sandbox/policy";

const root = "/tmp/seri-sandbox-root";
const policy = (allowUnsandboxedCommands: boolean): SandboxPolicy => ({
  allowUnsandboxedCommands,
  root,
});

describe("parseBangLine", () => {
  test("returns undefined for a task or slash command", () => {
    expect(parseBangLine("fix the wrap")).toBeUndefined();
    expect(parseBangLine("/mode")).toBeUndefined();
  });

  test("strips the bang and surrounding space", () => {
    expect(parseBangLine("!ls")).toBe("ls");
    expect(parseBangLine("!  touch /tmp/x")).toBe("touch /tmp/x");
  });

  test("empty bang is an empty command, not undefined", () => {
    expect(parseBangLine("!")).toBe("");
    expect(parseBangLine("!   ")).toBe("");
  });
});

describe("resolveShellLaunch", () => {
  test("strict floor with OS confinement keeps bang inside the root and declared os", () => {
    const launch = resolveShellLaunch("bang", policy(false), { available: true });
    expect(launch).toEqual({ kind: "sandboxed", declared: "os", root });
  });

  test("allowed bang with OS confinement flips the declared tier to unsandboxed", () => {
    const launch = resolveShellLaunch("bang", policy(true), { available: true });
    expect(launch).toEqual({ kind: "unsandboxed", declared: "unsandboxed" });
  });

  test("agent tool stays sandboxed even when bang may leave", () => {
    const launch = resolveShellLaunch("tool", policy(true), { available: true });
    expect(launch).toEqual({ kind: "sandboxed", declared: "os", root });
  });

  test("strict floor without confinement refuses rather than running host-unsandboxed", () => {
    const launch = resolveShellLaunch("bang", policy(false), { available: false });
    expect(launch).toEqual({
      kind: "refused",
      declared: "base",
      reason: BANG_REFUSED_REASON,
    });
  });

  test("no confinement and allow is host with declared base, not os", () => {
    const launch = resolveShellLaunch("bang", policy(true), { available: false });
    expect(launch).toEqual({ kind: "host", declared: "base" });
  });
});

describe("idleSandboxTier", () => {
  test("os only when confinement actually exists and bang is not allowed to leave", () => {
    expect(idleSandboxTier({ available: true })).toBe("os");
    expect(idleSandboxTier({ available: true }, false)).toBe("os");
    expect(idleSandboxTier({ available: false })).toBe("base");
    expect(idleSandboxTier({ available: false }, true)).toBe("base");
  });

  test("idle is unsandboxed when bang is allowed to leave a real OS sandbox", () => {
    expect(idleSandboxTier({ available: true }, true)).toBe("unsandboxed");
  });

  test("idle matches bang.declared so the mode row cannot claim a stricter tier than bang", () => {
    for (const allowUnsandboxedCommands of [true, false]) {
      for (const available of [true, false]) {
        const launch = resolveShellLaunch("bang", policy(allowUnsandboxedCommands), { available });
        expect(idleSandboxTier({ available }, allowUnsandboxedCommands)).toBe(launch.declared);
      }
    }
  });
});

describe("formatSandboxIndicator", () => {
  test("base adds nothing so the permission label is not claiming a sandbox", () => {
    expect(formatSandboxIndicator("base")).toBe("");
    expect(formatSandboxIndicator("os")).toBe(" · os sandbox");
    expect(formatSandboxIndicator("unsandboxed")).toBe(" · unsandboxed");
  });
});

describe("formatSandboxDoctorDetail", () => {
  test("strict confined bang", () => {
    expect(
      formatSandboxDoctorDetail("os", { kind: "sandboxed", declared: "os", root }, false),
    ).toBe("os · bang confined · unsandboxed commands disallowed");
  });

  test("allowed bang names the flip instead of staying labeled sandboxed", () => {
    expect(
      formatSandboxDoctorDetail("os", { kind: "unsandboxed", declared: "unsandboxed" }, true),
    ).toBe("os · bang unsandboxed (declared)");
  });

  test("host bang is declared base", () => {
    expect(formatSandboxDoctorDetail("base", { kind: "host", declared: "base" }, true)).toBe(
      "base · bang unsandboxed (declared)",
    );
  });

  test("refused bang names the floor", () => {
    expect(
      formatSandboxDoctorDetail(
        "base",
        { kind: "refused", declared: "base", reason: BANG_REFUSED_REASON },
        false,
      ),
    ).toBe("base · bang refused · unsandboxed commands disallowed");
  });
});
