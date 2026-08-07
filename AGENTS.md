# AGENTS.md

Guidance for AI agents working in this repository.

## What this is

seri is a cross-platform coding-agent CLI (ships as the `seri` binary), written in
TypeScript on Bun. It's currently mid-build against `docs/BUILD-PLAN.md` (Stage 4
"Checkpoints" landed 2026-08-04 and completes v1; abort/cancellation and prompt tiers
come next, then Stage 5). `docs/ARCHITECTURE.md` and `docs/RESEARCH.md` are the design spec
and research this plan is built from. A separate, parallel track (not a `docs/BUILD-PLAN.md`
stage) adds optional hosted accounts/billing on top of the BYOK-only core — Phase A
(WorkOS AuthKit device-flow auth) has shipped; see
`.claude/loops/hosted-accounts-billing-gateway/` for the full spec and phased plan.

## Scope: code-first, not code-only

Coding is the primary use and the only one this release ships for, but it is not the
boundary of the product — seri is intended to extend into general assistant work. This
is locked as constraint #3 in `docs/ARCHITECTURE.md`, and it constrains what you may
assume, not what you may build:

- **Don't reject a design for being assistant-shaped.** Reject on principle or on
  redundancy instead. Designs that are only coherent inside a repository are the ones
  ruled out — outside a repo there is no `AGENTS.md`, and the agent still has to work.
- **Don't broaden v1 either.** Assistant surfaces start at Stage 8 (the daemon), which
  is post-release. Everything before Stage 11 stays a coding agent.
- **Sequence early only what gets expensive later.** Profiles and the global instruction
  file are in Stage B on that argument alone; they ship no feature.

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
constructs one — `apps/cli/src/cli.ts` owns an `AbortController` per run, because only the consumer
knows what a Ctrl-C means. The signal reaches all three of `streamText`, `compactMessages`, and
every tool through `ToolExecutionOptions.abortSignal` (which rides through `withCheckpoints`
untouched, and which `bash`/`powershell`/`grep`/`glob` each forward to the process they spawn —
`read_file`/`edit` take it and have nothing to interrupt, and `write_file` forwards it to the
verification check it runs after the write — `verify/wrapTools.ts`), and the turn ends as
`done.reason: "aborted"` rather than as an `error`: a user-initiated cancel is not a failure. The
**first** press cancels the in-flight turn — `apps/cli/src/signals.ts` holds a single-slot
`onSignalCancel` callback and, **on SIGINT only**, returns from the handler *before* the fatal body,
so no cleanups run and the listener survives for the next press; a SIGTERM is not a press and still
terminates, because nothing that sends one is going to send a second — and the
loop unwinds far enough to write one `execution-denied` tool-result row for the interrupted call and
for every call after it, which is what leaves the session resumable (an unanswered tool call is
`AI_MissingToolResultsError` on the next `--resume`). When the loop returns, `cli.ts` calls
`raiseSignal`, so the process still dies **by** signal; `exit(0)` would report a status instead of a
death and turn one Ctrl-C into one press per iteration of `for f in a b c; do seri "$f"; done`. The
**second** press finds the slot empty and takes the untouched fatal path. When the turn was not
cancelled the status instead says whether it finished and accomplished anything: `done.reason:
"no-tool-call"` exits 0 unless the run was refused at least once AND executed no tool at all, in
which case it exits 1 too — asking for permission, getting no one, and doing nothing is not
success, even though the turn technically finished. A stream error (no `done` at all) and a run
stopped by the iteration cap or by repeated denials both exit 1 unconditionally, so `seri "…" &&
next` stops rather than chaining onto an unfinished turn. Making any of this
reachable is why `runRipgrep` — and therefore `grep`/`glob` — is async: `spawnSync` blocks the event
loop, so a SIGINT during a search was not delivered to any handler until rg finished on its own.
`spawnCollect` and `runRipgrep` **reject** when their child was killed by a cancel rather than
resolving with a normal-looking result, at the source rather than in the loop, because not every
caller is inside the loop.

**Gate-first permissions**, not sandboxing. `apps/cli/src/gate/gate.ts` defines three
`PermissionMode`s (`read-only` / `approve-each` / `auto`) that cycle via `/mode`. A new
session starts in `approve-each`, not `read-only`: native Windows does not enforce the OS
sandbox, so the gate is the whole Base layer and a default that does not ask is a default
that writes unattended. Answering `a`/always at the approval prompt adds that tool to a
run-local allowlist `checkPermission` consults on later calls — this is what keeps
`approve-each` from being an approve-*every*-call mode — but the allowlist never overrides
`read-only`: `checkPermission` checks `read-only` before consulting it, so a grant does not
survive a cycle into that mode. `seri --dangerously-skip-permissions` maps the mode to
`auto` for that run only and is never written back to the session, so a later `--continue`
still prompts. A run whose denied tool calls hit `MAX_CONSECUTIVE_DENIALS` (3) in a row
stops with `done: repeated-denials` instead of continuing to the turn cap — "in a row" counts
write calls only; an approved read (never blocked, in any mode) in between does not break it.
Whether a tool needs permission is derived from `WRITE_TOOL_NAMES` in
`apps/cli/src/provider/tools.ts` (single source of truth — a new write-capable tool must be
added there or it silently bypasses the gate). The AI SDK's automatic tool execution
is disabled (`execute` stripped before `streamText`); `runLoop` calls each tool's
`execute` itself, after the gate decides whether it's allowed to run.

**Tools are pure functions**, independently testable without a model:
`read_file`/`write_file`/`edit`/`grep`/`glob` (`apps/cli/src/tools/`), plus `bash` and
`powershell` — two separate shells, no translation layer between them (Windows always
gets a real PowerShell; bash is opt-in via Git Bash detection). `edit` is a 3-tier
match cascade (exact → line-trimmed → whitespace-normalized) with a
disproportionate-match guard against replacing far more than was asked for.

**Provider**: Vercel AI SDK, currently Groq only (`apps/cli/src/provider/groq.ts`,
`openai/gpt-oss-120b` default, any Groq model id via `SERI_MODEL`; the measurement
behind that default is in `docs/PROMPT-ROUTING.md`). API keys resolve from env var first, then
`~/.seri/config.json` (`%LOCALAPPDATA%\seri\` on Windows) — see
`apps/cli/src/config/paths.ts` / `apps/cli/src/config/config.ts`. `seri config
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

**Checkpoints** (`apps/cli/src/checkpoint/`): every call to one of the three tools that
can change the filesystem — `write_file`, `bash`, `powershell` (`FS_MUTATING_TOOL_NAMES`,
deliberately not `WRITE_TOOL_NAMES`, which is the permission set and includes `edit`, a
pure string transform that writes nothing) — snapshots the whole **project** into a bare
shadow git repo under `<configDir>/checkpoints/<sha256(projectRoot)[0..16]>/git`, keyed so
the project itself need not be a git repo and nothing is ever written into the user's
`.git`. The project is `git rev-parse --show-toplevel` from the session's cwd, falling back
to that cwd outside a repo, and **every** other question is derived from it — the
`--work-tree`, and therefore which `.gitignore` files are in scope; where the user's
`info/exclude` lives (`--git-path`, since `.git` is a file in a linked worktree); and the
store key. Deriving those separately produced the same leak three times in three layouts.
`seri [--resume <id>] /undo [n]` restores byte-identical prior state with a
reviewable diff and an explicit removal pass (`checkout-index` alone is additive);
`/rewind [n]` truncates the conversation to the same anchor and touches no file. Both
read one append-only JSONL log per session, and a pruned session's log is deleted with its
ref, so the log never outlives the snapshots it names. Compaction and `/rewind` both write
a barrier record, because each makes every anchor before it index into an array that no
longer exists.
`/undo` commits the state it replaced first and prints `/restore <commit>`, which takes
the same restore path back — recovery is a command that runs the removal pass, not a git
incantation pasted into a shell that would leave a state which never existed.
Two things a snapshot cannot cover, both warned about once per session rather than left
to be discovered: a **nested git repository** is staged as a gitlink holding only its HEAD
sha, so edits inside a submodule or vendored clone change the shadow tree not at all and
`/undo` will not revert them; and a project with **no `.gitignore`** is snapshotted whole
on every mutating call, with `/undo`'s removal pass reaching all of it. Neither is capped
— a threshold that silently narrowed the snapshot would be the skipped pre-state the
design refused. `runLoop` is still stateless and I/O-free: `withCheckpoints` is a pure function over a
`ToolSet` that `cli.ts` applies before injection, so checkpointing is consumer policy
and `loop.ts` has zero changes. The snapshot runs inside the wrapped `execute` before
delegating, and the callback returns `void` rather than `Promise<void>` so no `await`
can ever be introduced between the snapshot and the write.

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
