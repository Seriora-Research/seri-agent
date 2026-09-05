import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  classifyIoUringSetup,
  IO_URING_SYSCALLS,
  ioUringDenyFilter,
  ioUringDoctorCheck,
} from "../../src/sandbox/ioUring";

const CHILD = join(import.meta.dir, "../../src/sandbox/ioUringChild.ts");
const BPF_JMP_JEQ_K = 0x15;
const BPF_RET_K = 0x06;
const SECCOMP_RET_ERRNO_EPERM = 0x00050001;
const X32_SYSCALL_BIT = 0x40000000;

function runChild(mode: "probe" | "child" | "x32") {
  return spawnSync(process.execPath, [CHILD, mode], { encoding: "utf8" });
}

function filterInsns(filter: Uint8Array): { code: number; k: number }[] {
  const insns: { code: number; k: number }[] = [];
  const view = new DataView(filter.buffer, filter.byteOffset, filter.byteLength);
  for (let offset = 0; offset < filter.length; offset += 8) {
    insns.push({
      code: view.getUint16(offset, true),
      k: view.getUint32(offset + 4, true),
    });
  }
  return insns;
}

function filterKValues(filter: Uint8Array): number[] {
  return filterInsns(filter).map((insn) => insn.k);
}

const hostProbe = process.platform === "linux" ? runChild("probe") : undefined;

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

  test("kills x32 ABI numbers on x64 and not on arm64", () => {
    expect(filterKValues(ioUringDenyFilter("x64"))).toContain(X32_SYSCALL_BIT);
    expect(filterKValues(ioUringDenyFilter("arm64"))).not.toContain(X32_SYSCALL_BIT);
  });

  test("each denied syscall number is followed by RET ERRNO|EPERM", () => {
    for (const arch of ["x64", "arm64"] as const) {
      const insns = filterInsns(ioUringDenyFilter(arch));
      for (const nr of [425, 426, 427]) {
        const match = insns.findIndex((insn) => insn.code === BPF_JMP_JEQ_K && insn.k === nr);
        expect(match).toBeGreaterThan(-1);
        expect(insns[match + 1]).toEqual({ code: BPF_RET_K, k: SECCOMP_RET_ERRNO_EPERM });
      }
    }
  });
});

describe("classifyIoUringSetup", () => {
  test("treats a non-negative fd as allow", () => {
    expect(classifyIoUringSetup(3n, 0)).toEqual({ status: "allow" });
  });

  test("treats EPERM, ENOSYS, and EACCES as deny", () => {
    expect(classifyIoUringSetup(-1n, 1)).toEqual({ status: "deny" });
    expect(classifyIoUringSetup(-1n, 38)).toEqual({ status: "deny" });
    expect(classifyIoUringSetup(-1n, 13)).toEqual({ status: "deny" });
  });

  test("does not treat EMFILE as deny", () => {
    expect(classifyIoUringSetup(-1n, 24)).toEqual({
      status: "error",
      message: "io_uring_setup failed with errno 24",
    });
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

  test("is ok when io_uring_setup is rejected", () => {
    expect(ioUringDoctorCheck({ status: "deny" }, "linux")).toEqual({
      name: "io_uring",
      status: "ok",
      detail: "io_uring_setup is rejected",
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

  test("fails when the probe errors", () => {
    const check = ioUringDoctorCheck({ status: "error", message: "boom" }, "linux");
    expect(check.status).toBe("fail");
    expect(check.detail).toBe("boom");
  });

  test("allow does not fail the doctor run", () => {
    expect(ioUringDoctorCheck({ status: "allow" }, "linux").status).not.toBe("fail");
  });
});

describe.skipIf(process.platform !== "linux")("io_uring child", () => {
  test.skipIf(hostProbe?.stdout !== "allow\n")(
    "unfiltered child can create a ring when the kernel allows it",
    () => {
      const result = runChild("probe");
      expect(result.stdout).toBe("allow\n");
      expect(result.status).toBe(0);
    },
  );

  test("filtered child cannot create a ring", () => {
    const result = runChild("child");
    expect(result.stdout).toBe("deny\n");
    expect(result.status).toBe(1);
  });

  test.skipIf(process.arch !== "x64")("x32 io_uring_setup is killed, not allowed", () => {
    const result = runChild("x32");
    expect(result.stdout).not.toBe("allow\n");
    expect(result.signal === "SIGSYS" || result.status === 159).toBe(true);
  });
});
