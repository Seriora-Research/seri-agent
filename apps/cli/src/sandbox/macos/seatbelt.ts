// SBPL `localhost` matches `127.0.0.1` and `::1` but not IPv4-mapped IPv6
// `::ffff:127.0.0.1`. The parser rejects IP literals in `remote ip`
// (`host must be * or localhost`). A wildcard outbound rule would admit
// non-loopback egress, so mapped-form clients are rewritten to `127.0.0.1`
// instead.
export function seatbeltLoopbackAllow(): string {
  return [
    `(allow network-bind (local ip "*:*"))`,
    `(allow network-inbound (local ip "localhost:*"))`,
    `(allow network-outbound (remote ip "localhost:*"))`,
  ].join("\n");
}
