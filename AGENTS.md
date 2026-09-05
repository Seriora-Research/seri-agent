# AGENTS.md

Guidance for AI agents working in this repository.

## What this is

This repository is the seri CLI harness. It ships as the `seri` binary, written in
TypeScript on Bun. Work here is `apps/cli` and the packages that binary needs
(`packages/daemon-client`, `packages/model-catalog`, `packages/plans`).

## Scope: code-first, not code-only

Coding is the primary use and the only one this release ships for, but it is not the
boundary of the product — seri is intended to extend into general assistant work.
It constrains what you may assume, not what you may build: don't reject a design for
being assistant-shaped (a design only coherent inside a repository is what's actually
ruled out — there's no `AGENTS.md` outside one). Don't broaden v1 either — assistant
surfaces start at the daemon (post-release); everything up to the release gate stays
a coding agent.

## Commands

- `bun run dev -- <args>` — run the CLI from source
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
invocation (parseArgs rejected it, or no task was given). `--max-turns <n>` (default 500) is the
CLI-facing knob for `runLoop`'s own `maxIterations` option; the CLI also sets a handful of other
`runLoop` options that carry routing/cost/reasoning context rather than user-facing flags
(`provider`, `modelId`, `catalog`, `reasoningEffort`) — see `runLoop`'s own opts type
(`apps/cli/src/loop/loop.ts`) for the full list. After `--help`/`--version`/`--selftest`, argv
only launches: `seri serve`, `seri exec`, `seri doctor`, `seri update`, and a task (or a TTY idle TUI). `login`/`signup`/`logout`,
`config`, `permissions`, `usage`, and any `seri /slash` are not verbs. A positional `/foo` is
prompt text. `--continue`, `--resume`, `--max-turns`, `--profile`,
`--dangerously-skip-permissions`, and `--` stay.

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
only graceful exit is `/exit` (an exact match — trailing words show a command-error instead of
quitting, the same as every other TUI slash command's own `accepts()` guard failing shows a
command-error rather than silently falling through to a task) or Ctrl-D at the input box. If nothing
is running, both unmount the TUI immediately and resolve the run with a normal exit code and the
same final `printUsage` token/cost summary the non-interactive path prints, accumulated across
every turn the session ran (exit 0, the same as any other completed `no-tool-call` turn). If a
turn IS in flight, quitting cancels it first — the same `deliverSignal`/cancel-slot mechanism a
single Ctrl-C uses — and waits for it to actually unwind before exiting, so a tool mid-write is
never orphaned and whatever usage that turn had already spent still makes it into the summary;
the exit code in that case is 1, the same code every other *unaccomplished* run returns
(`max-iterations`, `repeated-denials`, a declined-and-nothing-ran `no-tool-call`) — not the
signal-death every OTHER abort path in this file uses, and not 0 either: `seri "task" && next`
must not run `next` off the back of a task `/exit` cut short. This assumes the cancel slot is
free; if a Ctrl-C already spent it (the paragraph above), quitting has nothing left to cancel
with and escalates straight to the fatal path instead, the same as a second Ctrl-C would — no
summary, no unwind, the process dies by signal.

**`--max-turns` in the TUI is a per-task budget, not a per-session one.** `driveLoop` is called fresh for
every submitted task in an interactive session (`runTui`'s own `runTurn`), each call getting the
same `maxIterations: maxTurns` passed at startup — so a session that submits five tasks gets up to
`maxTurns` model turns for EACH of them, not `maxTurns` total across the whole session, unlike the
non-interactive `seri <task>` invocation, where one `driveLoop` call is the whole run. Deliberate,
not a bug: a hard session-wide cap would make a long interactive session progressively less usable
the more it was used, which is not what an iteration cap is for.

**Gate-first permissions**, not sandboxing. `apps/cli/src/gate/gate.ts` defines three
`PermissionMode`s (`read-only` / `approve-each` / `auto`) that cycle via `/mode`. A new
session starts in `approve-each`, not `read-only`: native Windows does not enforce the OS
sandbox, so the gate is the whole Base layer and a default that does not ask is a default
that writes unattended. Answering `a`/always at the prompt adds the tool to an allowlist so
`approve-each` isn't an approve-*every*-call mode; for `write_file`/`edit` that grant also
persists across processes (`/permissions`, `<configDir>/permissions.yaml`).
**`bash`/`powershell` never get an "always" option, run-scoped or persisted** — a grant keyed
on a tool name says nothing about what a shell command will do. Neither tier survives a cycle
into `read-only`. `seri --dangerously-skip-permissions` maps to `auto` for that run only, never
written back to the session. Repeated declines (`MAX_CONSECUTIVE_DENIALS`, 3 in a row) stop the
run early rather than burning to the turn cap — only reachable in `approve-each`, since
`read-only` blocks outright and nothing is ever "declined" there. Full mechanics of the
permanent store are in `apps/cli/src/permissions/store.ts`'s own comments.

Whether a tool needs permission at all is derived from `WRITE_TOOL_NAMES` in
`apps/cli/src/provider/tools.ts` — **single source of truth**; a new write-capable tool must be
added there or it silently bypasses the gate. The one confirmed exception is `memory_write`
(`apps/cli/src/memory/tool.ts`): it is genuinely write-capable but deliberately kept out of
`WRITE_TOOL_NAMES`, because it writes under the profile root, not the worktree, and is gated
instead by the `/memory` approval-staging system plus the archivist's own hardcoded
`permissionMode: "auto"` — not by this gate at all. The AI SDK's automatic tool execution is
disabled (`execute` stripped before `streamText`); `runLoop` calls each tool's `execute` itself,
after the gate decides whether it's allowed to run.

**Tools are pure functions**, independently testable without a model:
`read_file`/`write_file`/`edit`/`grep`/`glob` (`apps/cli/src/tools/`), plus `bash` and
`powershell` — two separate shells, no translation layer between them (Windows always
gets a real PowerShell; bash is opt-in via Git Bash detection). `edit` is a 3-tier
match cascade (exact → line-trimmed → whitespace-normalized) with a
disproportionate-match guard against replacing far more than was asked for.

**Provider**: Vercel AI SDK, six providers — Groq (`apps/cli/src/provider/groq.ts`,
`openai/gpt-oss-120b` default, any Groq model id via `SERI_MODEL`), OpenRouter
(`apps/cli/src/provider/openrouter.ts`, `compatibility: "strict"`), native
Anthropic/OpenAI/Google (`apps/cli/src/provider/{anthropic,openai,google}.ts`), and xAI
(`apps/cli/src/provider/xai.ts`). `SERI_PROVIDER` (default `groq`) names
which one `SERI_MODEL` is read against. A new session starts on whichever (model, provider) pair
was last confirmed by a real turn — the built-in Groq default the first time, or a persisted
`/model` pick after that. Switching, mid-session, is the in-TUI `/model` picker
(`apps/cli/src/tui/App.tsx`'s `ModelPicker`) — context preserved, only written to disk once a
turn on the new model actually succeeds (`apps/cli/src/cli.ts`'s "pin only what worked"
invariant). Note this holds for a live switch specifically; a brand-new TUI session's
not-yet-confirmed model can still reach disk earlier via a mount-time effect — a separate,
pre-existing gap, not something this sentence should be read as claiming is closed. That same
"pin only what worked" confirmation is also what now persists `SERI_MODEL`/`SERI_PROVIDER` to
`config.json` (`apps/cli/src/provider/defaults.ts`'s `persistDefaultModel`), making a successful
pick the default for every future brand-new session, not just the current one — a session that
never touches `/model` never writes either key. A requested (model, provider) pair whose own
provider has no key is resolved ahead of dispatch by `resolveRoute`
(`apps/cli/src/provider/routing.ts`): if a sibling route to the same logical model (grouped by
`routeKey`, `packages/model-catalog/src/routes.ts` — vendor-aware, since the same model does not
share an id across providers) has a key, that sibling is used instead, native providers preferred
over an aggregator (Groq/OpenRouter); an explicit `/model` pick always wins over this if its own
provider has a key, and a reroute is announced once per turn in the transcript. `/model`'s picker
shows every route one model is reachable through, adjacently, with a `your key`/`no key` column.
`/setup` (inside the TUI) lists, adds, replaces and removes a BYOK key per provider, with one lightweight `generateText` probe rejecting a key
only on a 401/403; everything else stores it anyway with a warning, since an unverifiable-but-wrong
key still fails loudly on first real use, same as before this existed. All six providers' model metadata (context
window, pricing, tool-call/reasoning support) comes from a models.dev-sourced catalog
(`packages/model-catalog`, wrapped for the CLI in `apps/cli/src/provider/catalog.ts`), fetched
live with a bundled fallback manifest (`catalog-manifest.json`) for a failed fetch or
`SERI_DISABLE_MODELS_FETCH`. A run's dollar cost is reported with its provenance
(`apps/cli/src/provider/cost.ts`'s `CostReport`) — provider-reported `actual` for OpenRouter,
catalog-computed `estimated` for the other five (`reportFromCatalogPricing`), printed with a
visibly different line for each. API keys resolve from env var first, then
`~/.seri/config.json` — see
`apps/cli/src/config/paths.ts` / `apps/cli/src/config/config.ts`. A non-default profile
(`--profile <name>` or `SERI_PROFILE`, the flag wins) puts config.json, auth.json,
permissions.yaml, sessions/ and checkpoints/ under `<root>/<profile>/` instead; the vendored
`rg/` cache stays shared across every profile. `/setup` and `/config` write that file; it's written
owner-only and via write-then-rename, since it holds API keys and a partial write
would break every later command's `loadConfig`. Masked values and env-shadow flags live in
`/setup` rows, because `getApiKey` prefers `process.env`.

# Seri Code Review Guidelines

Seri is a research-oriented agentic coding harness designed to build, run,
evaluate, and improve autonomous software engineering agents.

## Review priorities

- Prioritize behavioral correctness and robustness over stylistic preferences.
- Treat agent loops, state, context, memory, and tool execution as high-risk areas.
- Flag unnecessary LLM calls, excessive token usage, avoidable latency, and inefficient tool usage.
- Flag hidden state, brittle control flow, race conditions, and problematic non-determinism.
- Check error handling, retries, recovery, cancellation, and failure modes.
- Prefer simple, testable, composable implementations.
- Avoid abstractions that do not solve a concrete problem.
- Consider extensibility across different models, agent strategies, memory systems,
  evaluators, and execution policies.
- For LLM-related changes, consider context quality, context-window limitations,
  model reliability, token usage, latency, and graceful degradation.
- Consider the impact of changes on autonomous task completion, reproducibility,
  observability, and debugging.

## Notes for agents

- Conductor is pstack (`/poteto-mode`): Feature or Bug fix, including Opening a PR.
  See `.cursor/rules/pstack.mdc`.
- `apps/cli/src/tools/rg-vendored.bin` is a vendored ripgrep binary fetched by
  `postinstall`/`vendorRipgrep.ts`; don't hand-edit it.
- Feature work lands via a branch + PR (`main` has branch protection), not a
  direct push. Do not merge the PR.
