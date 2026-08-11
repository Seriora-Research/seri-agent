// Every memory_write call is scanned before it reaches the store OR the pending queue (memory/
// tool.ts) — a memory file is re-read into every future session's system prompt, so anything that
// lands there is a standing instruction to the model, not a one-off answer that scrolls away.

export type InjectionCategory =
  | "credential"
  | "invisible-unicode"
  | "injection-phrasing"
  | "persistence-path"
  | "agent-config";

export type ScanResult =
  | { ok: true }
  | { ok: false; category: InjectionCategory; rule: string; reason: string };

type Rule = { category: InjectionCategory; name: string; pattern: RegExp };

// Checked in this order, first match wins — credential and invisible-unicode are the two
// categories with the clearest "this is never legitimate memory" signal, so they are checked
// first.
const RULES: Rule[] = [
  // credential — known key-prefix regexes plus one generic "name = value" assignment rule.
  { category: "credential", name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { category: "credential", name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { category: "credential", name: "groq-key", pattern: /\bgsk_[A-Za-z0-9]{20,}/ },
  { category: "credential", name: "github-pat-classic", pattern: /\bghp_[A-Za-z0-9]{36}\b/ },
  {
    category: "credential",
    name: "github-pat-fine-grained",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/,
  },
  { category: "credential", name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { category: "credential", name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { category: "credential", name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  {
    category: "credential",
    name: "private-key-block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    category: "credential",
    name: "assignment",
    pattern:
      /\b(?:api[_-]?key|secret|token|password|passwd|credential)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-+/=]{16,}/i,
  },
  // invisible-unicode — zero-width/formatting control chars, the Unicode Tags block (ASCII
  // smuggling), and variation selectors. Written as \u escapes, not literal glyphs, so this
  // source file itself stays free of the exact characters it is scanning for.
  //
  // control-formatting covers U+2060-U+206F as one continuous range, not two
  // (U+2060-U+2064 / U+206A-U+206F) with a gap between them: the gap, U+2065-U+2069, includes
  // the four bidi-isolate control characters (LRI/RLI/FSI/PDI, U+2066-U+2069) used in
  // "trojan-source" text-direction-spoofing attacks -- a memory_write containing one of those
  // four passed this scanner unflagged before this range closed the gap. U+2065 itself is an
  // unassigned reserved codepoint; including it in the range is harmless.
  {
    category: "invisible-unicode",
    name: "control-formatting",
    pattern: /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/,
  },
  { category: "invisible-unicode", name: "unicode-tags", pattern: /[\u{E0000}-\u{E007F}]/u },
  { category: "invisible-unicode", name: "variation-selector", pattern: /[\uFE00-\uFE0F]/ },
  // injection-phrasing — the wording a prompt-injected instruction typically uses.
  {
    category: "injection-phrasing",
    name: "ignore-previous",
    pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  },
  {
    category: "injection-phrasing",
    name: "disregard-previous",
    pattern: /disregard\s+(the\s+)?(previous|above|system|prior)/i,
  },
  { category: "injection-phrasing", name: "you-are-now", pattern: /\byou\s+are\s+now\b/i },
  {
    category: "injection-phrasing",
    name: "new-instructions",
    pattern: /\bnew\s+instructions\s*:/i,
  },
  { category: "injection-phrasing", name: "system-prompt", pattern: /\bsystem\s+prompt\b/i },
  {
    category: "injection-phrasing",
    name: "override",
    pattern: /override\b[\s\S]{0,20}\b(instructions|rules|guardrails)/i,
  },
  { category: "injection-phrasing", name: "do-not-tell", pattern: /do\s+not\s+tell\s+the\s+user/i },
  {
    category: "injection-phrasing",
    name: "without-telling",
    pattern: /without\s+(asking|telling|informing)\s+the\s+user/i,
  },
  {
    category: "injection-phrasing",
    name: "always-approve",
    pattern: /always\s+(approve|allow|run|say\s+yes)/i,
  },
  {
    category: "injection-phrasing",
    name: "skip-permissions-flag",
    pattern: /--dangerously-skip-permissions/i,
  },
  {
    category: "injection-phrasing",
    name: "bypass",
    pattern: /bypass\b[\s\S]{0,20}\b(permission|approval|gate)/i,
  },
  // persistence-path — paths a self-persisting agent would try to write to.
  { category: "persistence-path", name: "ssh-dir", pattern: /[~./\\]\.ssh\b/ },
  { category: "persistence-path", name: "authorized-keys", pattern: /\bauthorized_keys\b/ },
  {
    category: "persistence-path",
    name: "ssh-private-key-name",
    pattern: /\bid_(rsa|ed25519|ecdsa)\b/,
  },
  {
    category: "persistence-path",
    name: "shell-rc",
    pattern: /\.(bashrc|zshrc|bash_profile|profile)\b/,
  },
  { category: "persistence-path", name: "crontab", pattern: /\bcrontab\b/ },
  {
    category: "persistence-path",
    name: "etc-auth-files",
    pattern: /\/etc\/(passwd|shadow|sudoers)/,
  },
  { category: "persistence-path", name: "launch-agents", pattern: /\bLaunchAgents?\b/ },
  {
    category: "persistence-path",
    name: "systemd-unit",
    pattern: /\bsystemd\b[\s\S]{0,20}\b(service|unit)\b/,
  },
  {
    category: "persistence-path",
    name: "startup-folder",
    pattern: /\bStartup\b[\s\S]{0,10}\bfolder\b/,
  },
  { category: "persistence-path", name: "registry-hive", pattern: /HKEY_|HKCU:|HKLM:/ },
  { category: "persistence-path", name: "git-hooks", pattern: /\.git[\\/]hooks\b/ },
  // agent-config — path-shaped references to seri's OWN configuration only, never bare
  // AGENTS.md/CLAUDE.md: memory legitimately records "this repo's AGENTS.md requires X", and
  // rejecting that would make the scan reject its own best output.
  { category: "agent-config", name: "seri-dir", pattern: /\.seri[\\/]/ },
  { category: "agent-config", name: "permissions-yaml", pattern: /\bpermissions\.ya?ml\b/ },
  { category: "agent-config", name: "config-json", pattern: /\bconfig\.json\b/ },
  { category: "agent-config", name: "claude-settings", pattern: /\.claude[\\/]settings/ },
  { category: "agent-config", name: "seri-env", pattern: /\bSERI_[A-Z_]+\s*[:=]/ },
];

// The matched literal, truncated, so the archivist can see what tripped the scan and rephrase —
// except for `credential`, whose `reason` names the rule and offset only, never the matched value,
// because this rejection message goes back into the transcript as a tool error.
const MAX_MATCH_EXCERPT = 60;

export function scanForInjection(text: string): ScanResult {
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (match === null) continue;
    if (rule.category === "credential") {
      return {
        ok: false,
        category: rule.category,
        rule: rule.name,
        reason: `matched the "${rule.name}" rule at offset ${match.index}`,
      };
    }
    const excerpt =
      match[0].length > MAX_MATCH_EXCERPT ? `${match[0].slice(0, MAX_MATCH_EXCERPT)}…` : match[0];
    return { ok: false, category: rule.category, rule: rule.name, reason: `matched "${excerpt}"` };
  }
  return { ok: true };
}
