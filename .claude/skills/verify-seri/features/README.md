# seri verification map

This directory is the maintained source for verifying seri's user-facing behavior. Read the index, then use the matching feature file as the recipe.

**seri is used through the TUI in this project.** Every feature proof drives the interactive TUI under a real PTY; the non-interactive `seri <task>` prompt path is not a user path here and must not stand in for one. `config`, `permissions` and `usage` are TUI slash commands, not subcommands: `seri config list` sends a task to the model. The only sanctioned non-interactive drives are `--version`, `--help`, `--selftest`, `serve` and `exec`.

## Baseline preconditions

- Repo root is the working directory; `bun install` has run; `bun apps/cli/src/cli.ts --selftest` prints `selftest ok: ripgrep <version>`.
- `.env` exists at the repo root (supplies `GROQ_API_KEY` to fresh profiles).
- Every command carries `--profile verify-<run-id>` with a run-unique id. Never drive the default profile (`~\.seri\` directly).
- Evidence goes to `.claude/loops/verify-seri/<run-id>\`; the throwaway profile dir `~\.seri\verify-<run-id>\` is removed in cleanup, evidence is not.

## Driving conventions

- TUI drives: `node .claude/skills/verify-seri/scripts/drive-tui.mjs <transcript-out> <profile> <step...>` (steps: `wait=`/`wait=TEXT@MS`, `type=`, `key=`, `sleep=`) — **node, never bun** (bun-hosted ConPTY kills every child instantly on this machine), and `MSYS_NO_PATHCONV=1` when invoking from Git Bash.
- Always dismiss the splash first: `"wait=Esc continue" sleep=400 key=esc sleep=600`. Enter on the splash starts a real login device flow — Esc is "continue without logging in".
- The helper's outcome is its stderr `DRIVE-RESULT code=N` line plus the transcript; its process exit code and same-command stdout after it are unreliable under hosting shells. Read the transcript in a separate command.
- ApprovalBox answers are single keypresses (`type=y` / `type=a` / `type=n`), no Enter. Slash commands: `type=/x sleep=400 key=enter` (no echo-wait — cursor redraw splits short strings in the byte stream).
- Subcommand drives (the exception): plain process spawn from the repo root, capture stdout+stderr and `$LASTEXITCODE`.
- Model answers are nondeterministic — assert on seeded tokens and structural markers (`done ·`, mode labels, `[y]es`), never exact prose.
- A real model turn costs real (small) Groq usage; keep proof tasks one-turn-sized.

## Proof and skip reporting

- Capture the command, the full transcript, and the exit code for every drive.
- A mutation's proof includes a second, read-only view of the stored value (reopen `/config`, re-read the written file, list the sessions dir).
- Report an unreachable path with the attempted command and the unmet precondition; never report a skipped entry point as verified through a different path.

## Feature entry contract

Each file: H1 title, one paragraph of user-visible behavior, then exactly four H2s in order — `Sub-features`, `How to get to it (user POV)`, `Driving it with the verify-seri harness`, `Gotchas`.

## Features

- [Interactive TUI session](./tui-session.md) — splash, input box, submitting a task, `/exit` and Ctrl-D.
- [Permission gate](./permission-gate.md) — mode cycling, the ApprovalBox, read-only blocking, persisted grants.
- [Sessions](./sessions.md) — `--continue`, `--resume <id>`, `/clear`, the `sessions` table in `seri.db`.
- [Config and API keys](./config-keys.md) — `/config` and `/setup`, masking, env shadowing.

## Not yet mapped

Real user-facing surfaces with a source path and no feature file. Recorded so a later run picks
them up instead of rediscovering them; none has been driven.

- `/mcp` — server panel, `add`/`auth`/`remove`, and the trust preview that gates a catalog.
  `apps/cli/src/tui/routes/mcp/McpPanel.tsx`, `apps/cli/src/mcp/commands.ts`. Landed entirely
  after this map was written.
- `/memory` — staged memory-write review: list, diff, approve, reject.
  `apps/cli/src/memory/commands.ts`, `apps/cli/src/memory/pending.ts`.
- `/skills` — the skills panel and the staged-skill review subcommands.
  `apps/cli/src/tui/routes/skills/SkillsPanel.tsx`, `apps/cli/src/skills/commands.ts`.
- `/model` and `/effort` — mid-session model switch and the reasoning-effort override.
  `apps/cli/src/tui/components/ModelPicker.tsx`, `apps/cli/src/tui/routes/config/`.
- Checkpoints — `/undo`, `/rewind`, `/restore <sha>`. `apps/cli/src/checkpoint/`.
- `/compact` — in-session history summarization. `apps/cli/src/loop/compaction.ts`.
- Splash login/signup — the WorkOS device flow behind `/login`, `/signup`, `/logout`.
  `apps/cli/src/tui/routes/setup/`, `apps/cli/src/auth/`.
