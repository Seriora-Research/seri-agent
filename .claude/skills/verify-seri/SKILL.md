---
name: verify-seri
description: Drive the seri coding-agent TUI the way a user does — under a real PTY — and capture proof; CLI subcommands (config, permissions, usage) only as the non-interactive exception. Use when a change to apps/cli needs evidence it works in the real app, not just tests.
---

# Verify seri

seri is the CLI in `apps/cli`, and **this project uses it through the TUI**: a user runs `seri` in a real terminal, gets the full-screen session, and does everything there — tasks, approvals, `/mode`, `/model`, `/exit`. The non-interactive `seri <task>` path exists in the product but is not how seri is used here; do not verify a feature through it when the map gives a TUI path. The only non-TUI surfaces worth driving directly are the management subcommands (`config`, `permissions`, `usage`, `--version`, `--selftest`) — exceptions, not the product. The monorepo also has `apps/server`, `apps/web`, `apps/lab`, `apps/portal`; those are separate surfaces this skill does not cover.

Every run in this skill uses a throwaway profile (`--profile verify-<run-id>`, where `<run-id>` is unique per run, e.g. `verify-20260828a`). A profile isolates config.json, auth.json, permissions.yaml, sessions/ and checkpoints/ under `~\.seri\<profile>\` — the user's real state lives in `~\.seri\` directly (the default profile) and must never be driven or deleted. A fresh profile starts with no config, so it resolves provider `groq`, model `openai/gpt-oss-120b`, and the `GROQ_API_KEY` that bun auto-loads from the repo-root `.env` (env beats config.json). That key is real: a driven turn is a real model call.

## Launch

There is no server to keep alive; launch means: deps installed once, then each drive is its own short-lived TUI session in its own PTY.

```powershell
bun install            # once per checkout; also vendors ripgrep via postinstall
```

- **TUI session** (the primary drive; needs a real PTY — node-pty/ConPTY on Windows):
  `node .claude/skills/verify-seri/scripts/drive-tui.mjs <evidence>\tui.txt verify-<run-id> <step...>`
  **node, never bun** — bun as the node-pty host on this machine kills every ConPTY child instantly (exit -1073741510 after only `?9001h?1049h`-style enables); under node the same drive works, including from agent tool-shells. Do not set `SERI_DISABLE_MODELS_FETCH=1`; drive the same catalog fetch a user gets. From Git Bash also set `MSYS_NO_PATHCONV=1`, or `type=/exit` reaches the app as `C:/Program Files/Git/exit`. Ready when the transcript shows the splash (`SERI` wordmark and, on an unauthenticated profile, the login picker with footer `↑/↓ move · Enter select · Esc continue`).
- **Subcommands** (the exception — plain processes, piped stdio):
  `bun apps/cli/src/cli.ts --profile verify-<run-id> config list` etc., run from the repo root, stdout + `$LASTEXITCODE` captured directly.

## Doctor

Before driving anything, one read-only check from the repo root:

```powershell
bun apps/cli/src/cli.ts --selftest
```

Healthy prints exactly one line, `selftest ok: ripgrep <version>` (CLI loads, workspace links resolve, vendored ripgrep runs). If it errors with `Cannot find module '@seri/daemon-client'`, run `bun install` — the workspace links are missing, nothing else is wrong. Also confirm `Test-Path .env` at the repo root; without it a fresh profile has no Groq key and every real turn fails on auth, which looks like a product bug but is not one.

## Drive

**TUI.** `scripts/drive-tui.mjs` (invocation under Launch) spawns `seri` under ConPTY and executes steps in order: `wait=TEXT` (20s deadline), `type=TEXT`, `key=esc|enter|ctrl-c|ctrl-d|shift-tab`, `sleep=MS`. Extra CLI args (`--continue`, `--resume <id>`) go between the profile and a `::` separator: `drive-tui.mjs <out> <profile> --continue :: <step...>`. It always writes the full decoded transcript to its first argument, exits 0 only if every `wait=` matched, and kills what it spawned (matched by the unique profile name on the command line — one more reason the profile must be unique). A smoke drive:

```powershell
node .claude/skills/verify-seri/scripts/drive-tui.mjs <evidence>\tui.txt verify-<run-id> `
  "wait=Esc continue" sleep=400 key=esc "wait=created.@30000" sleep=600 `
  type=/exit sleep=400 key=enter sleep=800
```

And a real model turn (proven live: `done · 6324 ↑, 34 ↓` on `openai/gpt-oss-120b · your key`):

```powershell
node .claude/skills/verify-seri/scripts/drive-tui.mjs <evidence>\tui.txt verify-<run-id> `
  "wait=Esc continue" sleep=400 key=esc "wait=created.@30000" sleep=600 `
  "type=Reply with exactly the word SERI-TUI-PROOF" "wait=exactly the word" key=enter `
  "wait=done ·@90000" key=ctrl-d sleep=800
```

The verified drive pattern (each piece below was learned from a live failure — don't simplify it away):

- **Splash dismissal, always first:** `"wait=Esc continue" sleep=400 key=esc "wait=created.@30000" sleep=600`. The `created.` wait is load-bearing, not decoration: dismissing the splash does not mean the session exists, and until it does the app shows a `starting session…` placeholder that accepts no input. Typing into that window is what made issue #211 look like a hang. A fresh profile's splash is a login picker (`Log in / Sign up / Continue without logging in`); a bare Enter on it SELECTS "Log in" and starts a real WorkOS device flow (it can open a browser) — Esc is "continue without logging in". Never use the footer mode label as dismissal proof: it renders behind the splash too.
- **Submit a task:** `"type=<task>" "wait=<inner phrase of the task>" key=enter` — the echo-wait proves the input box had focus. The wait phrase must be a mid-text fragment of a longer task; short strings (and every slash command) get split by cursor redraw in the byte stream and never match.
- **Slash commands:** `type=/exit sleep=400 key=enter` — type, settle, submit; no echo-wait.
- **Turn completion:** `"wait=done ·@90000"` — a real turn needs the longer deadline (`@MS` suffix).
- **Outcome:** the helper's stderr `DRIVE-RESULT code=0` line plus the transcript are the result; the process exit code and any stdout after the helper in the same shell command are unreliable (the ConPTY plumbing swallows them — observed as exit 255 on fully green drives). Run the helper as its own command and read the transcript in a separate one. The post-quit `(tokens: …)` summary may flush after capture ends — assert `done · <n> ↑, <n> ↓` from the turn status instead.

A write tool in `approve-each` mode raises the ApprovalBox — `[y]es / [a]lways (saved for this project) / [N]o` — answered by a single `type=y` / `type=a` / `type=n` keypress, no Enter. Stable handles to `wait=` on, all rendered by the real app: `Esc continue` (splash up), `┌` (box border — the TUI renders `┌`, never `╭`), `Session ` + `created.` (TUI mounted past the splash), `⏸ approve-each mode on` / `⏸ read-only mode on` / `⏵⏵ bypass permissions on` (mode label, cycled by `key=shift-tab`), `[y]es` (ApprovalBox up), `done ·` (turn finished). Prefer these over screen positions.

**Subcommands** are the exception for what has no TUI path or needs a non-interactive read: `config set|list|unset`, `permissions list|remove`, `usage`, `--version`, `--help` (always with `--profile verify-<run-id>` when they touch state). Capture stdout + exit code directly.

## Evidence

Evidence for run `<run-id>` goes to `.claude/loops/verify-seri/<run-id>\` — gitignored (`.claude/loops/` is per-run local state by this repo's own convention), and it survives cleanup.

Proof standards:
- Exercise the real user path — the TUI under a PTY, never an imported function, a faked `runLoop`, or the non-interactive prompt path standing in for a TUI feature. The unit tests already cover the fakes.
- Capture the action and the result: the full helper command line, the complete transcript file, and the exit code (recorded in a `.txt` next to the transcript).
- Verify side effects, not just the screen: a write task's file content afterward; a config change re-read with `config list`; a session's `~\.seri\verify-<run-id>\sessions\` entry; a persisted grant in `permissions list`.
- A model's answer is nondeterministic prose — seed a token (`SERI-VERIFY-<run-id>`) and assert on it appearing, not on wording.
- Gate proofs answer the real ApprovalBox in `approve-each` or `read-only`. `--dangerously-skip-permissions` is a real product flag but a run using it proves nothing about the gate.

## Cleanup

Kill only what you started; the helper already does this for TUI drives (unique-profile match, never image name). Then:

```powershell
Remove-Item -Recurse -Force ~\.seri\verify-<run-id>   # the throwaway profile — NEVER ~\.seri itself
```

plus any probe files or scratch dirs the run created. Evidence under `.claude/loops/verify-seri/<run-id>\` is not cleanup's to remove. If a drive fails mid-way, run this same cleanup before retrying so broken attempts don't strand ConPTY children or half-written profiles.

## Isolation limits

- Two verification runs coexist if their profiles differ; never reuse a run-id.
- `seri serve` binds a loopback daemon per profile — do not drive a daemon this run did not start, and do not start one on the user's default profile.
- The default profile's config sets OpenRouter; a throwaway profile deliberately does not inherit it. If a proof specifically needs the user's provider setup, say so and get confirmation instead of driving the default profile silently.

## Feature map

`features/README.md` is the index; one file per user-facing feature is the maintained recipe. A proof that drives one convenient entry point is incomplete when the map lists others. Keep the map honest with `/pstack:maintain-verification-skill`.
