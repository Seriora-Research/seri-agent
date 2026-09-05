import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  IO_URING_SYSCALLS,
  ioUringDenyFilter,
  ioUringDoctorCheck,
} from "../../src/sandbox/ioUring";

const CHILD = join(import.meta.dir, "../../src/sandbox/ioUringChild.ts");

function runChild(mode: "probe" | "child") {
  return spawnSync(process.execPath, [CHILD, mode], { encoding: "utf8" });
}

function filterKValues(filter: Uint8Array): number[] {
  const values: number[] = [];
  const view = new DataView(filter.buffer, filter.byteOffset, filter.byteLength);
  for (let offset = 0; offset < filter.length; offset += 8) {
    values.push(view.getUint32(offset + 4, true));
  }
  return values;
}

describe("IO_URING_SYSCALLS", () => {
  test("is the three io_uring syscalls", () => {
    expect([...IO_URING_SYSCALLS]).toEqual([
      "io_uring_setup",
      "io_uring_enter",
      "io_uring_register",
    ]);
  });
});

describe("ioUringDenyFilter", () => {
  test("packs setup, enter, and register numbers into the BPF k fields", () => {
    const ks = filterKValues(ioUringDenyFilter("x64"));
    expect(ks).toContain(425);
    expect(ks).toContain(426);
    expect(ks).toContain(427);
  });

  test("uses a different AUDIT_ARCH k for arm64 than x64", () => {
    const x64 = filterKValues(ioUringDenyFilter("x64"));
    const arm64 = filterKValues(ioUringDenyFilter("arm64"));
    expect(x64).toContain(0xc000003e);
    expect(arm64).toContain(0xc00000b7);
    expect(x64).not.toContain(0xc00000b7);
    expect(arm64).not.toContain(0xc000003e);
  });
});

describe("ioUringDoctorCheck", () => {
  test("warns when the kernel allows io_uring_setup", () => {
    const check = ioUringDoctorCheck({ status: "allow" }, "linux");
    expect(check.status).toBe("warn");
    expect(check.name).toBe("io_uring");
    expect(check.detail).toContain("io_uring_setup");
    expect(check.detail).toContain("io_uring_enter");
    expect(check.detail).toContain("io_uring_register");
    expect(check.fix).toContain("io_uring_disabled=2");
  });

  test("is ok when the kernel rejects io_uring_setup", () => {
    expect(ioUringDoctorCheck({ status: "deny" }, "linux")).toEqual({
      name: "io_uring",
      status: "ok",
      detail: "kernel rejects io_uring_setup",
    });
  });

  test("is info on non-Linux", () => {
    const check = ioUringDoctorCheck({ status: "allow" }, "darwin");
    expect(check.status).toBe("info");
    expect(check.detail).toContain("darwin");
  });

  test("is info when the probe is unsupported", () => {
    expect(ioUringDoctorCheck({ status: "unsupported" }, "linux").status).toBe("info");
  });

  test("never fails the doctor run", () => {
    expect(ioUringDoctorCheck({ status: "allow" }, "linux").status).not.toBe("fail");
    expect(ioUringDoctorCheck({ status: "error", message: "boom" }, "linux").status).not.toBe(
      "fail",
    );
  });
});

describe.skipIf(process.platform !== "linux")("io_uring child", () => {
  test("unfiltered child can create a ring when the kernel allows it", () => {
    const result = runChild("probe");
    expect(result.stdout).toBe("allow\n");
    expect(result.status).toBe(0);
  });

  test("filtered child cannot create a ring", () => {
    const result = runChild("child");
    expect(result.stdout).toBe("deny\n");
    expect(result.status).toBe(1);
  });
});
