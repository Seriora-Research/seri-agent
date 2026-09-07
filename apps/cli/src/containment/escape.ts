import { resolveConfigValue } from "../config/config";
import { isMcpToolName } from "../mcp/types";

export const CONTAINMENT_ESCAPE_EXPECTED_KEY = "SERI_CONTAINMENT_ESCAPE_EXPECTED";

export type EscapeKind = "imds" | "egress-evasion" | "cross-tenant";

export type BlockReason =
  | { kind: "escape"; class: EscapeKind; label: string }
  | { kind: "unparseable"; detail: string };

export type ScreenResult = { outcome: "pass" } | { outcome: "block"; reason: BlockReason };

const SCAN_LIMIT = 65536;


export function parseExpectedEnvironment(raw: string | undefined): boolean {
  return raw === "true";
}

export function loadContainmentExpected(config: Record<string, string>): boolean {
  if (Object.hasOwn(process.env, CONTAINMENT_ESCAPE_EXPECTED_KEY)) {
    return parseExpectedEnvironment(process.env[CONTAINMENT_ESCAPE_EXPECTED_KEY]);
  }
  return parseExpectedEnvironment(
    resolveConfigValue(CONTAINMENT_ESCAPE_EXPECTED_KEY, config).value,
  );
}

const FETCH_NEAR = String.raw`(?:https?:\/\/|\bcurl\b|\bwget\b|\binvoke-webrequest\b|\binvoke-restmethod\b|\biwr\b|\birm\b|\bnc\b|\bncat\b|\bsocat\b|\/dev\/tcp)`;

function nearFetch(target: string): RegExp {
  return new RegExp(
    `(?:${FETCH_NEAR})[\\s\\S]{0,80}${target}|${target}[\\s\\S]{0,80}(?:${FETCH_NEAR})`,
    "i",
  );
}

const ESCAPE_TABLE: readonly { kind: EscapeKind; pattern: RegExp; label: string }[] = [
  {
    kind: "imds",
    pattern: nearFetch(String.raw`\b169\.254\.169\.254\b`),
    label: "link-local cloud metadata IPv4 169.254.169.254",
  },
  {
    kind: "imds",
    pattern: nearFetch(String.raw`\b169\.254\.170\.2\b`),
    label: "ECS task-credentials IPv4 169.254.170.2",
  },
  {
    kind: "imds",
    pattern: nearFetch(String.raw`\b169\.254\.170\.23\b`),
    label: "EKS pod-identity IPv4 169.254.170.23",
  },
  {
    kind: "imds",
    pattern: nearFetch(String.raw`\b100\.100\.100\.200\b`),
    label: "Alibaba metadata IPv4 100.100.100.200",
  },
  {
    kind: "imds",
    pattern: nearFetch(String.raw`\b192\.0\.0\.192\b`),
    label: "OCI metadata IPv4 192.0.0.192",
  },
  {
    kind: "imds",
    pattern: nearFetch(String.raw`\bfd00:ec2::254\b`),
    label: "AWS IMDS IPv6 fd00:ec2::254",
  },
  {
    kind: "imds",
    pattern: nearFetch(String.raw`\bmetadata\.google\.internal\b`),
    label: "GCP metadata hostname metadata.google.internal",
  },
  {
    kind: "imds",
    pattern: nearFetch(String.raw`\bmetadata\.goog\b`),
    label: "GCP metadata hostname metadata.goog",
  },
  {
    kind: "imds",
    pattern: /\/latest\/meta-data/i,
    label: "EC2 IMDS meta-data path",
  },
  {
    kind: "imds",
    pattern: /\/latest\/api\/token/i,
    label: "EC2 IMDSv2 token path",
  },
  {
    kind: "imds",
    pattern: /\/computeMetadata\/v1/i,
    label: "GCP computeMetadata/v1 path",
  },
  {
    kind: "imds",
    pattern: /\/metadata\/identity\/oauth2\/token/i,
    label: "Azure IMDS identity token path",
  },
  {
    kind: "imds",
    pattern: /\/opc\/v2/i,
    label: "OCI IMDS opc/v2 path",
  },
  {
    kind: "imds",
    pattern: /AWS_CONTAINER_CREDENTIALS_RELATIVE_URI/i,
    label: "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  },
  {
    kind: "imds",
    pattern: /AWS_CONTAINER_CREDENTIALS_FULL_URI/i,
    label: "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  },
  {
    kind: "egress-evasion",
    pattern: /\bssh\b(?:\s+-\S+)*\s+-(?:[A-Za-z]*[DLRW])(?:\s|$|=|[0-9A-Za-z.:/])/,
    label: "ssh tunnel",
  },
  {
    kind: "egress-evasion",
    pattern: /\bssh\b[\s\S]*\b(?:LocalForward|RemoteForward|DynamicForward)\b/i,
    label: "ssh tunnel",
  },
  {
    kind: "egress-evasion",
    pattern: /\bssh\b[\s\S]*ProxyCommand/i,
    label: "ssh ProxyCommand",
  },
  { kind: "egress-evasion", pattern: /\bngrok\b/i, label: "ngrok" },
  { kind: "egress-evasion", pattern: /\bcloudflared\s+tunnel\b/i, label: "cloudflared tunnel" },
  { kind: "egress-evasion", pattern: /\bchisel\b/i, label: "chisel" },
  { kind: "egress-evasion", pattern: /\biodine\b/i, label: "iodine" },
  { kind: "egress-evasion", pattern: /\bdnscat/i, label: "dnscat" },
  { kind: "egress-evasion", pattern: /\bproxychains/i, label: "proxychains" },
  { kind: "egress-evasion", pattern: /\b(?:nc|ncat)\b[\s\S]*\s-e(?:\s|$)/i, label: "nc -e" },
  { kind: "egress-evasion", pattern: /\bncat\b[\s\S]*--(?:exec|sh-exec)\b/i, label: "ncat --exec" },
  { kind: "egress-evasion", pattern: /\/dev\/tcp\
  { kind: "egress-evasion", pattern: /\/dev\/udp\
  {
    kind: "egress-evasion",
    pattern: /\bcurl\b[\s\S]*\s-x(?:\s|$|=|\S)/,
    label: "curl/wget proxy or resolve flag",
  },
  {
    kind: "egress-evasion",
    pattern:
      /\b(?:curl|wget)\b[\s\S]*(?:--proxy(?:\s|=(?!off\b)|$)|--socks5\b|--connect-to\b|--resolve\b|--doh-url\b)/i,
    label: "curl/wget proxy or resolve flag",
  },
  {
    kind: "cross-tenant",
    pattern: /\baws\b[\s\S]*\bsts\b[\s\S]*\bassume-role\b/i,
    label: "aws sts assume-role",
  },
  { kind: "cross-tenant", pattern: /assume[-_]role\b/i, label: "assume-role" },
  { kind: "cross-tenant", pattern: /--role-arn\b/i, label: "--role-arn" },
  {
    kind: "cross-tenant",
    pattern: /\bgcloud\b[\s\S]*impersonate-service-account\b/i,
    label: "gcloud impersonate-service-account",
  },
  {
    kind: "cross-tenant",
    pattern: /\baz\b[\s\S]*\baccount\b[\s\S]*\bget-access-token\b[\s\S]*--tenant\b/i,
    label: "az account get-access-token --tenant",
  },
  {
    kind: "cross-tenant",
    pattern: /\bkubectl\b[\s\S]*\bcreate\s+token\b/i,
    label: "kubectl create token",
  },
  { kind: "cross-tenant", pattern: /\bkubectl\b[\s\S]*--as(?:=|\s)/i, label: "kubectl --as=" },
  { kind: "cross-tenant", pattern: /\bUse-STSRole\b/i, label: "Use-STSRole" },
  {
    kind: "cross-tenant",
    pattern: /\bGet-AzAccessToken\b[\s\S]*-TenantId\b/i,
    label: "Get-AzAccessToken -TenantId",
  },
];

function decodeOnce(text: string): string {
  return text
    .replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeAll(text: string): string {
  let out = text;
  for (let i = 0; i < 3; i++) {
    const next = decodeOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

type Extracted =
  | { status: "empty" }
  | { status: "ready"; text: string }
  | { status: "unparseable"; detail: string };

function extract(subject: string, input: unknown): Extracted {
  if (subject === "bash" || subject === "powershell") {
    if (typeof input !== "object" || input === null) {
      return { status: "unparseable", detail: "unparseable command" };
    }
    const command = (input as { command?: unknown }).command;
    if (typeof command !== "string") {
      return { status: "unparseable", detail: "unparseable command" };
    }
    if (command.length > SCAN_LIMIT) {
      return { status: "unparseable", detail: "command exceeds scan limit" };
    }
    return { status: "ready", text: command };
  }
  if (subject === "mcp" || isMcpToolName(subject)) {
    if (typeof input !== "object" || input === null) {
      return { status: "unparseable", detail: "unparseable MCP arguments" };
    }
    try {
      const record = input as { arguments?: unknown; tool?: unknown };
      const identity = [subject, typeof record.tool === "string" ? record.tool : ""].join(" ");
      if (record.arguments === undefined) {
        return { status: "ready", text: identity };
      }
      if (
        typeof record.arguments !== "object" ||
        record.arguments === null ||
        Array.isArray(record.arguments)
      ) {
        return { status: "unparseable", detail: "unparseable MCP arguments" };
      }
      const serialized = JSON.stringify(record.arguments);
      if (typeof serialized !== "string") return { status: "ready", text: identity };
      if (serialized.length > SCAN_LIMIT) {
        return { status: "unparseable", detail: "MCP arguments exceed scan limit" };
      }
      return { status: "ready", text: `${identity} ${serialized}` };
    } catch {
      return { status: "unparseable", detail: "unparseable MCP arguments" };
    }
  }
  return { status: "empty" };
}

export function screenCall(subject: string, input: unknown, expected: boolean): ScreenResult {
  const extracted = extract(subject, input);
  if (extracted.status === "unparseable") {
    return { outcome: "block", reason: { kind: "unparseable", detail: extracted.detail } };
  }
  if (extracted.status === "empty") return { outcome: "pass" };
  if (expected) return { outcome: "pass" };



  // MCP arguments are JSON, so prefix http:// — they have no curl/wget neighbor for the classifier.
  const raw =
    subject === "mcp" || isMcpToolName(subject) ? `http:// ${extracted.text}` : extracted.text;
  const decoded = decodeAll(raw);
  const folded = decoded.toLowerCase();
  for (const row of ESCAPE_TABLE) {
    const extra = row.pattern.ignoreCase ? folded : decoded;
    if (row.pattern.test(raw) || row.pattern.test(extra)) {
      return { outcome: "block", reason: { kind: "escape", class: row.kind, label: row.label } };
    }
  }
  return { outcome: "pass" };
}
