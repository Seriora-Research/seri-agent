export type SandboxTier = "base" | "os" | "unsandboxed";

export type ShellEntry = "bang" | "tool";

export type SandboxPolicy = {
  allowUnsandboxedCommands: boolean;
  root: string;
};

export type Confinement = {
  available: boolean;
};

export type ShellLaunch =
  | { kind: "sandboxed"; declared: "os"; root: string }
  | { kind: "unsandboxed"; declared: "unsandboxed" }
  | { kind: "host"; declared: "base" }
  | { kind: "refused"; declared: "base"; reason: string };

export const BANG_REFUSED_REASON =
  "unsandboxed commands are disallowed and no OS sandbox is available";

export function idleSandboxTier(
  confinement: Confinement,
  allowUnsandboxedCommands = false,
): SandboxTier {
  if (!confinement.available) return "base";
  return allowUnsandboxedCommands ? "unsandboxed" : "os";
}

export function resolveShellLaunch(
  entry: ShellEntry,
  policy: SandboxPolicy,
  confinement: Confinement,
): ShellLaunch {
  if (confinement.available) {
    if (entry === "bang" && policy.allowUnsandboxedCommands) {
      return { kind: "unsandboxed", declared: "unsandboxed" };
    }
    return { kind: "sandboxed", declared: "os", root: policy.root };
  }
  if (!policy.allowUnsandboxedCommands) {
    return { kind: "refused", declared: "base", reason: BANG_REFUSED_REASON };
  }
  return { kind: "host", declared: "base" };
}

export function formatSandboxIndicator(tier: SandboxTier): string {
  if (tier === "os") return " · os sandbox";
  if (tier === "unsandboxed") return " · unsandboxed";
  return "";
}

export function formatSandboxDoctorDetail(
  idle: SandboxTier,
  bang: ShellLaunch,
  allowUnsandboxedCommands: boolean,
): string {
  const bangPart =
    bang.kind === "sandboxed"
      ? "bang confined"
      : bang.kind === "refused"
        ? "bang refused"
        : "bang unsandboxed (declared)";
  if (allowUnsandboxedCommands) return `${idle} · ${bangPart}`;
  return `${idle} · ${bangPart} · unsandboxed commands disallowed`;
}

export function parseBangLine(trimmed: string): string | undefined {
  if (!trimmed.startsWith("!")) return undefined;
  return trimmed.slice(1).trim();
}
