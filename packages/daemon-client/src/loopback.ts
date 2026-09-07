export const LOOPBACK_V4 = "127.0.0.1";
export const LOOPBACK_V6 = "::1";
export const LOOPBACK_MAPPED_V4 = "::ffff:127.0.0.1";

export type LoopbackVerifyExpectation = "allow" | "unsupported";

export type LoopbackVerifyCase = {
  readonly host: string;
  readonly expected: LoopbackVerifyExpectation;
};

export const LOOPBACK_VERIFY_BAR: readonly LoopbackVerifyCase[] = [
  { host: LOOPBACK_V4, expected: "allow" },
  { host: LOOPBACK_V6, expected: "allow" },
  { host: LOOPBACK_MAPPED_V4, expected: "unsupported" },
];

function stripIpv6Brackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

function ipv4FromHextets(hiHex: string, loHex: string): string {
  const hi = Number.parseInt(hiHex, 16);
  const lo = Number.parseInt(loHex, 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function ipv4FromMapped(host: string): string | undefined {
  // URL parsers rewrite ::ffff:127.0.0.1 to ::ffff:7f00:1; both name the same IPv4 loopback.
  const dotted = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (dotted !== null) return dotted[1];
  const expandedDotted = host.match(/^(?:0:){5}ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (expandedDotted !== null) return expandedDotted[1];
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex !== null) return ipv4FromHextets(hex[1]!, hex[2]!);
  const expandedHex = host.match(/^(?:0:){5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (expandedHex === null) return undefined;
  return ipv4FromHextets(expandedHex[1]!, expandedHex[2]!);
}

export function canonicalizeLoopbackHost(host: string): string {
  const stripped = stripIpv6Brackets(host);
  const key = stripped.toLowerCase();
  if (key === "localhost") return stripped;
  if (key === LOOPBACK_V6 || key === "0:0:0:0:0:0:0:1") return LOOPBACK_V6;
  if (key === LOOPBACK_V4) return LOOPBACK_V4;
  if (ipv4FromMapped(key) === LOOPBACK_V4) return LOOPBACK_V4;
  return stripped;
}

export function canonicalizeLoopbackUrl(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return endpoint;
  }
  const nextHost = canonicalizeLoopbackHost(url.hostname);
  if (nextHost === url.hostname || nextHost === stripIpv6Brackets(url.hostname)) {
    return endpoint;
  }
  const hadTrailingSlash = endpoint.endsWith("/");
  url.hostname = nextHost;
  let href = url.href;
  if (!hadTrailingSlash && href.endsWith("/") && url.pathname === "/") {
    href = href.slice(0, -1);
  }
  return href;
}
