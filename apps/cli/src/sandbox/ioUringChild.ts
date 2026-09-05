import { dlopen, FFIType, ptr } from "bun:ffi";
import { installIoUringDeny, probeIoUringSetup } from "./ioUring";

const mode = process.argv[2];
if (mode === "child" || mode === "x32") {
  installIoUringDeny();
} else if (mode !== "probe") {
  process.stderr.write("usage: ioUringChild.ts probe|child|x32\n");
  process.exit(2);
}

if (mode === "x32") {
  const libc = dlopen("libc.so.6", {
    syscall: { args: [FFIType.i64, FFIType.u32, FFIType.ptr], returns: FFIType.i64 },
  });
  libc.symbols.syscall(BigInt(0x40000000 | 425), 1, ptr(new Uint8Array(128)));
  process.stdout.write("allow\n");
  process.exit(0);
}

const probe = probeIoUringSetup();
if (probe.status === "allow") {
  process.stdout.write("allow\n");
  process.exit(0);
}
if (probe.status === "deny") {
  process.stdout.write("deny\n");
  process.exit(1);
}
process.stderr.write(`${probe.status}\n`);
process.exit(2);
