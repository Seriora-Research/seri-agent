import { installIoUringDeny, probeIoUringSetup } from "./ioUring";

const mode = process.argv[2];
if (mode === "child") {
  installIoUringDeny();
} else if (mode !== "probe") {
  process.stderr.write("usage: ioUringChild.ts probe|child\n");
  process.exit(2);
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
