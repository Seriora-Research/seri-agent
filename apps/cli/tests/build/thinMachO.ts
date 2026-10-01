export const MH_MAGIC_64 = 0xfeedfacf;
const LC_UUID = 0x1b;
const LC_SEGMENT_64 = 0x19;
const CPU_TYPE_ARM64 = 0x0100000c;
const MH_EXECUTE = 2;

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

export function thinMachO(uuid: string, extra: Uint8Array): Uint8Array {
  const uuidCmd = Buffer.concat([Buffer.from([LC_UUID, 0, 0, 0, 24, 0, 0, 0]), uuidBytes(uuid)]);
  const segname = Buffer.concat([Buffer.from("__TEXT"), Buffer.alloc(10)]);
  const segment = Buffer.concat([
    Buffer.from([LC_SEGMENT_64, 0, 0, 0, 72, 0, 0, 0]),
    segname,
    Buffer.alloc(48),
  ]);
  const cmds = Buffer.concat([uuidCmd, segment]);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(MH_MAGIC_64, 0);
  header.writeInt32LE(CPU_TYPE_ARM64, 4);
  header.writeUInt32LE(MH_EXECUTE, 12);
  header.writeUInt32LE(2, 16);
  header.writeUInt32LE(cmds.length, 20);
  return new Uint8Array(Buffer.concat([header, cmds, extra]));
}
