import { describe, expect, test } from "bun:test";
import {
  LOOPBACK_MAPPED_V4,
  LOOPBACK_V4,
  LOOPBACK_V6,
  LOOPBACK_VERIFY_BAR,
} from "@seri/daemon-client";
import { seatbeltLoopbackAllow } from "../../src/sandbox/macos/seatbelt";

function loopbackPolicyAllowsNonLoopbackEgress(policy: string): boolean {
  return /remote ip "\*:/.test(policy);
}

describe("seatbeltLoopbackAllow", () => {
  test("emits the three localhost bind and connect allows and no wildcard egress", () => {
    const policy = seatbeltLoopbackAllow();
    expect(policy).toContain(`(allow network-bind (local ip "*:*"))`);
    expect(policy).toContain(`(allow network-inbound (local ip "localhost:*"))`);
    expect(policy).toContain(`(allow network-outbound (remote ip "localhost:*"))`);
    expect(policy).not.toContain(`remote ip "*:*"`);
    expect(policy).not.toContain(`remote ip "*:`);
  });

  test("mapped form is not an excuse for wildcard egress", () => {
    const policy = seatbeltLoopbackAllow();
    expect(loopbackPolicyAllowsNonLoopbackEgress(policy)).toBe(false);
    const mutated = `${policy}\n(allow network-outbound (remote ip "*:*"))`;
    expect(loopbackPolicyAllowsNonLoopbackEgress(mutated)).toBe(true);
  });
});

describe("LOOPBACK_VERIFY_BAR", () => {
  test("covers 127.0.0.1, ::1, and unsupported mapped form", () => {
    expect(LOOPBACK_VERIFY_BAR).toEqual([
      { host: LOOPBACK_V4, expected: "allow" },
      { host: LOOPBACK_V6, expected: "allow" },
      { host: LOOPBACK_MAPPED_V4, expected: "unsupported" },
    ]);
    expect(LOOPBACK_VERIFY_BAR).toHaveLength(3);
    expect(LOOPBACK_MAPPED_V4).toBe("::ffff:127.0.0.1");
  });
});
