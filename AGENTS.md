# AGENTS.md

Guidance for AI agents working in this repository.

## What this is

seri is a cross-platform coding-agent CLI (ships as the `seri` binary), written in
TypeScript on Bun. Current build stage and what's next: `docs/ROADMAP.md` (source of
truth for status; `docs/BUILD-PLAN.md` has the reasoning behind it). `docs/ARCHITECTURE.md`
and `docs/RESEARCH.md` are the design spec and research this plan is built from. A separate,
parallel track (not a `docs/BUILD-PLAN.md` stage) adds optional hosted accounts/billing
on top of the BYOK-only core — Phase A (WorkOS AuthKit device-flow auth) has shipped; see
`.claude/loops/hosted-accounts-billing-gateway/` for the full spec and phased plan.

## Scope: code-first, not code-only

Coding is the primary use and the only one this release ships for, but it is not the
boundary of the product — seri is intended to extend into general assistant work
(constraint #3, `docs/ARCHITECTURE.md`). It constrains what you may assume, not what
you may build: don't reject a design for being assistant-shaped (a design only
coherent inside a repository is what's actually ruled out — there's no `AGENTS.md`
outside one). Don't broaden v1 either — assistant surfaces start at Stage 8
(post-release); everything before Stage 11 stays a coding agent.

## Commands

- `bun run dev -- <args>` — run the CLI from source (CLI only; `bun run dev:server`
  for `apps/server`)
- `bun test` — run the test suite (bun's built-in runner)
- `bun test path/to/file.test.ts` — run a single test file
- `bun run typecheck` (alias `lint`) — `tsc --noEmit`
- `bun run build` — compile to `dist/seri` for the current platform
- CI (`.github/workflows/ci.yml`) runs typecheck + test + build on Linux, macOS, and
  Windows on every push — treat all three as required, not just the local OS

## Architecture

**The loop is a library, not a CLI.** `apps/cli/src/loop/loop.ts` (`runLoop`) is a stateless
async generator: it takes a model, tools, and messages, and yields `LoopEvent`s
(text-delta, tool-call, tool-result, permission-denied, compacted, done, error). It
never touches stdout/stdin directly. `apps/cli/src/cli.ts` is a thin consumer that prints events
and prompts for approval. This boundary is deliberate and load-bearing — a future
daemon/transport layer is expected to consume the same generator.

**argv is parsed once, in `cli.ts`, with `node:util`'s `parseArgs`** — the loop never sees argv.
Flags are flags in any position and remaining positionals are the task; `--` is the documented
escape for a task that contains what looks like a flag (`seri -- fix the --help output`). Exit
codes: **0** a request was served or the turn finished, **1** the turn did not finish, **2** a bad
invocation (parseArgs rejected it, or no task was given; `config`'s own invocation errors also
exit 2). `--max-turns <n>` is the only `runLoop` option the CLI sets, default 500. `--help`/
`--version`/`--selftest` are checked before any subcommand dispatch, so `seri login --help` (and
`signup`/`logout`) prints seri's own usage rather than reaching the subcommand.

**Cancellation belongs to the consumer.** `runLoop` accepts an optional `AbortSignal` and never
constructs one — `apps/cli/src/cli.ts` owns an `AbortController` per run. The signal reaches
`streamText`, `compactMessages`, and every tool via `ToolExecutionOptions.abortSignal`. The
**first** Ctrl-C cancels the in-flight turn (`done.reason: "aborted"`, not an `error` — a
user-initiated cancel isn't a failure) and leaves the session resumable; the **second** is fatal.
Exit codes otherwise track whether the turn accomplished anything: `no-tool-call` exits 0 unless
every write attempt was declined and nothing executed (exits 1 too); a mode `read-only` block is
not a failure (still 0); the iteration cap and `repeated-denials` both exit 1. Mechanism and the
platform-specific gotchas (SIGINT-vs-SIGTERM, why `runRipgrep` has to be async so a search can be
interrupted) live in `apps/cli/src/signals.ts` — read its comments before touching signal
handling, don't re-derive the sequencing from this summary.

**On a real terminal (the Ink TUI, `apps/cli/src/tui/`), the same first-cancels/second-is-fatal
rule only holds while a turn is actually in flight** — the cancel slot is registered for the
duration of one `driveLoop` call, not the process's whole lifetime, so a Ctrl-C pressed while
nothing is running (between turns) finds the slot already empty and is immediately fatal, not a
"first press" with a second still to come. The TUI never exits on its own once a turn
completes — it returns to awaiting input for another task or slash command, indefinitely; the
only graceful exit is `/exit` or Ctrl-D at the input box, both of which unmount the TUI and
resolve the run with a normal exit code and the same final `printUsage` token/cost summary the
non-interactive path prints, accumulated across every turn the session ran.

**Gate-first permissions**, not sandboxing. `apps/cli/src/gate/gate.ts` defines three
`PermissionMode`s (`read-only` / `approve-each` / `auto`) that cycle via `/mode`. A new
session starts in `approve-each`, not `read-only`: native Windows does not enforce the OS
sandbox, so the gate is the whole Base layer and a default that does not ask is a default
that writes unattended. Answering `a`/always at the prompt adds the tool to an allowlist so
`approve-each` isn't an approve-*every*-call mode; for `write_file`/`edit` that grant also
persists across processes (`seri permissions list|remove`, `<configDir>/permissions.yaml`).
**`bash`/`powershell` never get an "always" option, run-scoped or persisted** — a grant keyed
on a tool name says nothing about what a shell command will do. Neither tier survives a cycle
into `read-only`. `seri --dangerously-skip-permissions` maps to `auto` for that run only, never
written back to the session. Repeated declines (`MAX_CONSECUTIVE_DENIALS`, 3 in a row) stop the
run early rather than burning to the turn cap — only reachable in `approve-each`, since
`read-only` blocks outright and nothing is ever "declined" there. Full mechanics of the
permanent store are in `apps/cli/src/permissions/store.ts`'s own comments.

Whether a tool needs permission at all is derived from `WRITE_TOOL_NAMES` in
`apps/cli/src/provider/tools.ts` — **single source of truth**; a new write-capable tool must be
added there or it silently bypasses the gate. The AI SDK's automatic tool execution is disabled
(`execute` stripped before `streamText`); `runLoop` calls each tool's `execute` itself, after the
gate decides whether it's allowed to run.

**Tools are pure functions**, independently testable without a model:
`read_file`/`write_file`/`edit`/`grep`/`glob` (`apps/cli/src/tools/`), plus `bash` and
`powershell` — two separate shells, no translation layer between them (Windows always
gets a real PowerShell; bash is opt-in via Git Bash detection). `edit` is a 3-tier
match cascade (exact → line-trimmed → whitespace-normalized) with a
disproportionate-match guard against replacing far more than was asked for.

**Provider**: Vercel AI SDK, currently Groq only (`apps/cli/src/provider/groq.ts`,
`openai/gpt-oss-120b` default, any Groq model id via `SERI_MODEL`; the measurement
behind that default is in `docs/PROMPT-ROUTING.md`). API keys resolve from env var first, then
`~/.seri/config.json` — see
`apps/cli/src/config/paths.ts` / `apps/cli/src/config/config.ts`. A non-default profile
(`--profile <name>` or `SERI_PROFILE`, the flag wins) puts config.json, auth.json,
permissions.yaml, sessions/ and checkpoints/ under `<root>/<profile>/` instead; the vendored
`rg/` cache stays shared across every profile. `seri config
set|list|unset` (`apps/cli/src/config/commands.ts`) manages that file; it's written
owner-only and via write-then-rename, since it holds API keys and a partial write
would break every later command's `loadConfig`. `list` masks values and flags any
shadowed by an env var, because `getApiKey` prefers `process.env`.

**Sessions** (`apps/cli/src/session/session.ts`) persist as one JSON file per session under
`<configDir>/sessions/`; `--resume <id>` reloads that session, `--continue` reloads the most
recent one. SQLite was considered and deferred in favor of this for v0/v1.

**Compaction** (`apps/cli/src/loop/compaction.ts`) triggers once input tokens cross a threshold
of the model's context window. It summarizes evicted messages into a structured
goal/progress/blockers/nextSteps recap via `generateText` (not `generateObject` — see
recent commit history for why) and never cuts the eviction boundary in the middle of an
{assistant tool-call, tool result} pair, since that reproduces
`AI_MissingToolResultsError`.

**Checkpoints** (`apps/cli/src/checkpoint/`): every call to a filesystem-mutating tool —
`write_file`, `bash`, `powershell` (`FS_MUTATING_TOOL_NAMES`, deliberately not
`WRITE_TOOL_NAMES`, since `edit` is a pure string transform that writes nothing) — snapshots
the whole **project** into a bare shadow git repo under
`<configDir>/checkpoints/<sha256(projectRoot)[0..16]>/git`, keyed off `git rev-parse
--show-toplevel` from the session's cwd (falling back to that cwd outside a repo) so nothing
is ever written into the user's own `.git`. `seri [--resume <id>] /undo [n]` restores
byte-identical prior state with a reviewable diff; `/rewind [n]` truncates conversation
history to the same anchor and touches no file. Two things a snapshot cannot cover, each
warned about once per session: a **nested git repository** (staged as a gitlink, not
reverted by `/undo`) and a project with **no `.gitignore`** (snapshotted whole, uncapped).
`runLoop` stays stateless — `withCheckpoints` wraps the `ToolSet` in `cli.ts`, `loop.ts` has
zero changes. Staging mechanics, the log/ref pruning invariant, and `/restore` are documented
in the module's own comments.

**Auth** (`apps/cli/src/auth/`): `seri login`/`signup`/`logout`, backed by WorkOS AuthKit's
OAuth device-authorization flow (RFC 8628) — purely additive, zero changes to
`apps/cli/src/provider/groq.ts` or the BYOK path in `apps/cli/src/config/config.ts`. `deviceFlow.ts`
requests + polls (honoring `authorization_pending`/`slow_down`/`expired_token`/
`access_denied`); `authStore.ts` persists the session as a single `auth.json` under
`getConfigDir()` (owner-only file permissions, not the per-id `sessions/` pattern —
there's exactly one auth session per machine); `browser.ts` best-effort opens the
verification URL via the existing `spawnCollect`, no new dependency; `commands.ts`
orchestrates (`login`/`signup` are the same underlying call — WorkOS's hosted UI
handles sign-in vs. sign-up). `cli.ts` dispatches these subcommands before the
existing task/`--resume`/`/mode` handling, mirroring the `/mode` carve-out.

**AGENTS.md loading**: on a fresh (non-resumed) session, `apps/cli/src/agents/loadAgentsFile.ts`
walks up from `cwd` looking for the nearest `AGENTS.md` and prepends its contents to
the system prompt. This file is that file, for this repo.

## Notes for agents

- `.claude/` holds this project's own Claude Code loop/agent/skill configuration
  (engineering-loop, retro, etc.) — it's gitignored and orthogonal to seri's own code.
- `apps/cli/src/tools/rg-vendored.bin` is a vendored ripgrep binary fetched by
  `postinstall`/`vendorRipgrep.ts`; don't hand-edit it.
- Feature work lands via a branch + PR (`main` has branch protection), not direct
  pushes — see `.claude/rules/git-workflow.md` if present.
