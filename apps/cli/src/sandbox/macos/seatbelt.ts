




// SBPL `localhost` matches 127.0.0.1 and ::1 but not ::ffff:127.0.0.1; the parser rejects IP literals in `remote ip`.
export function seatbeltLoopbackAllow(): string {
  return [
    `(allow network-bind (local ip "*:*"))`,
    `(allow network-inbound (local ip "localhost:*"))`,
    `(allow network-outbound (remote ip "localhost:*"))`,
  ].join("\n");
}
