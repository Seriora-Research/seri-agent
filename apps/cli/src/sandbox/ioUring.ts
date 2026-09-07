import { dlopen, FFIType, ptr, read } from "bun:ffi";
import type { CheckResult } from "../doctor/report";

export const IO_URING_SYSCALLS = ["io_uring_setup", "io_uring_enter", "io_uring_register"] as const;

export type IoUringSyscall = (typeof IO_URING_SYSCALLS)[number];
export type LinuxArch = "x64" | "arm64";
export type IoUringProbe =
  | { status: "allow" }
  | { status: "deny" }
  | { status: "unsupported" }
  | { status: "error"; message: string };



const SYSCALL_NR: Record<IoUringSyscall, number> = {
  io_uring_setup: 425,
  io_uring_enter: 426,
  io_uring_register: 427,
};

const AUDIT_ARCH: Record<LinuxArch, number> = {
  x64: 0xc000003e,
  arm64: 0xc00000b7,
};

const BPF_LD = 0x00;
const BPF_W = 0x00;
const BPF_ABS = 0x20;
const BPF_JMP = 0x05;
const BPF_JEQ = 0x10;
const BPF_JGE = 0x30;
const BPF_K = 0x00;
const BPF_RET = 0x06;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO = 0x00050000;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_DATA = 0x0000ffff;
const EPERM = 1;
const EACCES = 13;
const ENOSYS = 38;
const X32_SYSCALL_BIT = 0x40000000;
const PR_SET_NO_NEW_PRIVS = 38;
const PR_SET_SECCOMP = 22;
const SECCOMP_MODE_FILTER = 2;

function insn(code: number, jt: number, jf: number, k: number): number[] {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, code, true);
  bytes[2] = jt;
  bytes[3] = jf;
  view.setUint32(4, k >>> 0, true);
  return [...bytes];
}

export function ioUringDenyFilter(arch: LinuxArch): Uint8Array {
  const bytes: number[] = [
    ...insn(BPF_LD | BPF_W | BPF_ABS, 0, 0, 4),
    ...insn(BPF_JMP | BPF_JEQ | BPF_K, 1, 0, AUDIT_ARCH[arch]),
    ...insn(BPF_RET | BPF_K, 0, 0, SECCOMP_RET_KILL_PROCESS),
    ...insn(BPF_LD | BPF_W | BPF_ABS, 0, 0, 0),
  ];


  if (arch === "x64") {
    // x32 syscalls share AUDIT_ARCH_X86_64 with bit 0x40000000 set on nr; without this JGE they miss 425/426/427.
    bytes.push(
      ...insn(BPF_JMP | BPF_JGE | BPF_K, 0, 1, X32_SYSCALL_BIT),
      ...insn(BPF_RET | BPF_K, 0, 0, SECCOMP_RET_KILL_PROCESS),
    );
  }
  for (const name of IO_URING_SYSCALLS) {
    bytes.push(
      ...insn(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, SYSCALL_NR[name]),
      ...insn(BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
    );
  }
  bytes.push(...insn(BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ALLOW));
  return Uint8Array.from(bytes);
}

function linuxArch(arch: string): LinuxArch | undefined {
  if (arch === "x64" || arch === "arm64") return arch;
  return undefined;
}

function openLibc() {
  return dlopen("libc.so.6", {
    syscall: { args: [FFIType.i64, FFIType.u32, FFIType.ptr], returns: FFIType.i64 },
    prctl: {
      args: [FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.u64],
      returns: FFIType.i32,
    },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  });
}

function errnoOf(libc: ReturnType<typeof openLibc>): number {
  const location = libc.symbols.__errno_location();
  if (location === null) throw new Error("__errno_location returned null");
  return read.i32(location, 0);
}

export function classifyIoUringSetup(
  fd: bigint,
  errno: number,
): Exclude<IoUringProbe, { status: "unsupported" }> {
  if (fd >= 0n) return { status: "allow" };
  if (errno === EPERM || errno === ENOSYS || errno === EACCES) return { status: "deny" };
  return { status: "error", message: `io_uring_setup failed with errno ${errno}` };
}

export function probeIoUringSetup(): IoUringProbe {
  if (process.platform !== "linux") return { status: "unsupported" };
  try {
    const libc = openLibc();
    const params = new Uint8Array(128);
    const fd = libc.symbols.syscall(BigInt(SYSCALL_NR.io_uring_setup), 1, ptr(params));
    if (fd >= 0n) {
      libc.symbols.close(Number(fd));
      return { status: "allow" };
    }
    return classifyIoUringSetup(fd, errnoOf(libc));
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

export function installIoUringDeny(): void {
  if (process.platform !== "linux") {
    throw new Error("io_uring deny is Linux-only");
  }
  const arch = linuxArch(process.arch);
  if (arch === undefined) {
    throw new Error(`io_uring deny has no filter for arch ${process.arch}`);
  }
  const filter = ioUringDenyFilter(arch);
  const libc = openLibc();
  const program = new Uint8Array(16);
  const view = new DataView(program.buffer);
  view.setUint16(0, filter.length / 8, true);
  view.setBigUint64(8, BigInt(ptr(filter)), true);
  if (libc.symbols.prctl(PR_SET_NO_NEW_PRIVS, 1n, null, 0n, 0n) !== 0) {
    throw new Error("PR_SET_NO_NEW_PRIVS failed");
  }
  if (libc.symbols.prctl(PR_SET_SECCOMP, BigInt(SECCOMP_MODE_FILTER), ptr(program), 0n, 0n) !== 0) {
    throw new Error("PR_SET_SECCOMP failed");
  }
}

export function ioUringDoctorCheck(probe: IoUringProbe, platform: NodeJS.Platform): CheckResult {
  const names = IO_URING_SYSCALLS.join(", ");
  if (platform !== "linux") {
    return {
      name: "io_uring",
      status: "info",
      detail: `io_uring is Linux-only (${platform})`,
    };
  }
  if (probe.status === "allow") {
    return {
      name: "io_uring",
      status: "warn",
      detail: `kernel allows io_uring_setup; a seccomp filter that omits ${names} is bypassable`,
      fix: "sysctl kernel.io_uring_disabled=2 (Linux 6.6+) turns io_uring off host-wide",
    };
  }
  if (probe.status === "deny") {
    return { name: "io_uring", status: "ok", detail: "io_uring_setup is rejected" };
  }
  if (probe.status === "unsupported") {
    return { name: "io_uring", status: "info", detail: "io_uring probe skipped" };
  }
  return {
    name: "io_uring",
    status: "fail",
    detail: probe.message,
    fix: "doctor could not probe io_uring_setup; the host may still allow it",
  };
}
