# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security report.**

Report privately through
[GitHub's private vulnerability reporting](https://github.com/lzvxck/seri-agent/security/advisories/new),
or by email to **larce@seriora.ai**.

Please include the version (`seri --version`), your OS, what an attacker can achieve,
and the steps to reproduce it. A proof of concept helps but isn't required to file.

You'll get an acknowledgement within 72 hours and an assessment within 7 days. If a fix
is warranted, we'll agree on a disclosure timeline with you before publishing, and credit
you in the advisory unless you'd rather stay anonymous.

## Scope

seri runs arbitrary shell commands and holds API keys, so the interesting boundaries are:

- **The permission gate** (`apps/cli/src/gate/`) — anything that makes a write-capable
  tool run without the approval it should have required, including a tool that isn't
  covered by `WRITE_TOOL_NAMES`.
- **Credential handling** — API keys in `~/.seri/config.json` (`%LOCALAPPDATA%\seri\` on
  Windows) and the auth session in `auth.json`: file permissions, leakage into logs,
  session output, or error messages.
- **Checkpoints** (`apps/cli/src/checkpoint/`) — anything that writes outside the shadow
  repo, reads or corrupts the user's own `.git`, or snapshots files it was told to
  ignore.
- **The install scripts and released binaries** — `install.sh`, `install.ps1`, and the
  `SHA256SUMS` verification in each release.

Out of scope: that the agent can be prompted into running a destructive command *after*
the user approves it — the gate is the control, and `auto` mode is documented as
trusting the model. Vulnerabilities in the underlying model provider belong to that
provider.

## Supported versions

Only the latest release receives security fixes. seri is pre-1.0 and moves fast; there
are no backports to earlier tags.
