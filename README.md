# seri

[![CI](https://github.com/lzvxck/seri-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/lzvxck/seri-agent/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/lzvxck/seri-agent)](./LICENSE)

seri is a cross-platform coding-agent CLI, built toward being a genuinely definitive agent
harness rather than a clone of any one of them. It ships as a single `seri` binary — no
runtime to install — written in TypeScript on [Bun](https://bun.com), and runs natively on
Windows, macOS, and Linux (no WSL2 or Docker required).

## Scope

seri is **code-first, not code-only**. Coding is what it does today, and it is the only thing
this release is built for — the tools it ships are file, search, and shell tools. The loop, the
session store, and the permission model are deliberately not bounded to a repository, and
general assistant work is a planned direction, not a shipped feature: **evaluate seri today as
a coding agent.**

## How it works

seri has one entry point: run `seri` and it opens a full-screen terminal session. Every
capability below is a slash command inside that session.

- **A permission gate as the base safety layer**, on every OS: `read-only` / `approve-each` /
  `auto`, one keystroke to cycle (`/mode`). A tool you approve with "always" is remembered —
  for `write_file`/`edit` that persists across sessions.
- **Checkpoints, undo, and rewind.** Every filesystem-mutating tool call commits to a shadow
  git ref, independent of your own branch. `/undo [n]`, `/rewind [n]`, `/restore <sha>` walk it
  back without touching your commit history.
- **Subagents.** The model can dispatch named, isolated-context roles (`explore`, `plan`,
  `code`, `test`) for parts of a task that benefit from their own context window.
- **Persistent memory.** After a turn, an `archivist` role can write facts it learned to
  `MEMORY.md`/`USER.md` outside the repo. Writes are staged for approval by default
  (`/memory` opens the review panel), never applied silently, and can be turned off
  entirely (`/memory archivist off`).
- **Five providers, one routing layer.** Groq, OpenRouter, Anthropic, OpenAI, and Google,
  switchable mid-session (`/model`) without losing context, with automatic reroute to a
  provider you have a key for when the one you picked doesn't have one.
- **A verify-after-write loop.** Point seri at your project's own check command and it runs
  after every successful write, feeding diagnostics back to the model in the same turn.

## Install

### macOS

```sh
curl -fsSL https://seri-agent.seriora.ai/install.sh | bash
```

### Linux

```sh
curl -fsSL https://seri-agent.seriora.ai/install.sh | bash
```

Installs to `~/.local/bin`. If that directory isn't on your `PATH`, the script prints the
line to add — it never edits your shell config for you.

### Windows

```powershell
irm https://seri-agent.seriora.ai/install.ps1 | iex
```

Installs to `~\.seri\bin` and adds it to your user `PATH`. No admin rights
required. Open a new terminal afterwards so the `PATH` change takes effect.

### Without piping to a shell

If you'd rather not run a script straight from the internet, download the binary for your
platform from [Releases](https://github.com/lzvxck/seri-agent/releases), make it
executable, and put it somewhere on your `PATH`. Both install scripts are short enough to
read first, and both verify the download against the `SHA256SUMS` file published with each
release — that catches a truncated or corrupted download, not a compromised release.

## Getting started

```sh
seri
```

That's the whole invocation — seri opens the TUI. On a first run, guided setup asks how you want
to pay for models: bring your own provider key and pick a model explicitly (`/setup` gets you
back here later to add, replace, or remove one — setting the matching environment variable
before you launch, `GROQ_API_KEY` say, works too), or sign into a hosted seri account
(`/login`) and skip key management.

A signed-in account defaults to `openai/gpt-oss-120b` via OpenRouter, chosen by measurement: on
the same task, the same prompt and a fresh session each run, it made a real tool call in 20 of 20
runs where `llama-3.3-70b-versatile` managed 5 of 11. BYOK has no such default — you choose a
model as part of setup. Either way, `/model` switches it, mid-session, without losing context; a
pick whose next turn actually succeeds becomes the default for every future brand-new session,
not just the one you picked it in.

Anthropic, OpenAI and Google work the same BYOK way as Groq and OpenRouter:

| provider | key |
| --- | --- |
| Groq | `GROQ_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google | `GOOGLE_GENERATIVE_AI_API_KEY` |

`SERI_PROVIDER` names which of the five `SERI_MODEL` should be read against; both are
environment variables, and both are also what a successful `/model` pick persists for you. If a
model is reachable through more than one provider (a model available both directly from
Anthropic and through OpenRouter, say) and the pair you're on has no key, seri reroutes to
whichever configured provider reaches the same model — native providers preferred over an
aggregator like OpenRouter — and says so once in the transcript. An explicit `/model` pick always
wins over this if its own provider has a key.

Subagent roles (`explore`, `plan`, `code`, `test`, `oracle`) inherit the session
`(provider, model)` unless a task names a different pair. Ask the parent to dispatch and name
the child model in the prompt — there is no `seri config` subcommand for this:

```text
Dispatch an oracle to review the permission gate. Use anthropic / claude-sonnet-5 at high.
```

The parent fills that task's `model`, `provider`, and optional `effort` on `dispatch_subagents`.
`provider` is one of `groq`, `openrouter`, `anthropic`, `openai`, `google`; `model` is that
provider's id (OpenRouter: the OpenRouter slug). A model without a valid provider is ignored, not
mixed with the session provider. A pair that cannot be constructed warns and falls back to the
session model rather than failing the turn.

`oracle` is a read-only advisor seat (it cannot write or run commands). Naming a stronger model
on the task is how it escalates; omitted, it still runs in isolated context on the session model.

Optional env defaults `SERI_ROLE_<ROLE>_MODEL` + `SERI_ROLE_<ROLE>_PROVIDER` apply when a task
omits the pair (scripts, and the hidden archivist, which cannot be dispatched). `/effort` on the
session still copies onto a child only when that child actually runs the same pair, unless the
task itself names `effort`.

The first search of each release unpacks its bundled ripgrep to `~/.seri/rg/<key>/`. Deleting that
directory is safe — the next search writes it again — and a run that cannot write there falls back
to a temporary copy.

## Commands

| Command | Does |
| --- | --- |
| `/mode` | cycle the permission mode: `read-only` → `approve-each` → `auto` |
| `/model` | open the model picker, across all five providers and every route to a given model |
| `/effort [level\|auto]` | show, set, or clear (`auto`) this session's reasoning-effort override — legal levels depend on the current model |
| `/setup` | add, replace, or remove a provider API key without leaving the session |
| `/config` | view or edit non-provider settings (e.g. the verify command) |
| `/permissions` | view or revoke tools you've permanently approved |
| `/undo [n]`, `/rewind [n]`, `/restore <sha>` | step back through checkpoints |
| `/clear` | start a new session (clears the conversation) — the previous one stays recoverable with `seri --resume <id>` |
| `/compact` | summarize older messages in this session so the conversation fits the context window |
| `/memory` | review staged memory writes: preview a diff, approve or reject |
| `/memory pending\|diff\|approve\|reject` | the same review as flat lines, for copy-pasting an id |
| `/memory archivist on\|off` | turn the post-turn learning pass off entirely |
| `/trajectory [on\|off]` | show or turn local trajectory recording on or off (default on; persists for the profile) |
| `/login`, `/signup`, `/logout` | sign in to, create, or leave a hosted seri account |
| `/usage [--detail]` | hosted-gateway spend vs allowance, reset date, and a burn-rate projection |
| `/<agent> <task>` | run one of your own subagents on a task — see below |
| `/skills` | open the skills panel: every skill this project and this profile define |
| `/skills pending\|diff\|approve\|reject` | review and act on skills the archivist proposed |
| `/<skill> [args]` | run one of your own skills — see below |
| `/mcp` | open the MCP panel: connect a server, preview its tools, and trust or remove it |
| `/mcp add <name> <url>`, `/mcp remove <name>` | add or remove an MCP server without opening the panel |
| `/profile new <name>` | create a new profile — an isolated config/memory/session root |
| `/max-turns <n>` | override the per-task turn budget (default 500) for the rest of the session |
| `/exit` | end the session (or Ctrl-D) |

Approve-with-always still means once per tool, not a blanket grant for the session; and skipping
approval prompts entirely for attended, high-trust work is a mode you opt into, not a default.

`/clear` is a different kind of reset from the automatic compaction that trims an over-long
conversation mid-session: compaction is transparent and partial (it summarizes older messages so
the turn can keep going), while `/clear` is explicit and full — every message is gone from the new
session's view, only recoverable by resuming the old one. Each `/clear` leaves the previous
session's file on disk with no retention or cleanup policy; that's accepted, not a bug — the same
way a plain `seri <task>` already leaves one file per session behind. The checkpoint store is a
separate matter: it keeps only the most recently touched 20 sessions per project, so `/clear`ing
repeatedly in one long-lived process can eventually prune an earlier session's checkpoint history
(what `/undo`/`/rewind` act on) even though its conversation file never goes away.

## Your own subagents

Drop a Markdown file in `.seri/agents/` (this project) or under your profile root (every project) —
`~/.seri/agents/` by default, `~/.seri/<profile>/agents/` under `--profile <name>` — and seri picks
it up at the next start. No source change, no registration step.

```markdown
---
name: reviewer                  # optional — the filename without .md is the default
description: Grades a diff against the plan. Read-only. Never edits code.
tools: Read, Grep, Glob         # seri names (read_file, grep, …) work too, case-insensitively
model: inherit                  # or a concrete id; `some-model[effort=high]` is understood
effort: high
---

You are a senior reviewer in a FRESH context. Report CRITICAL/HIGH/MEDIUM/LOW findings
with file:line. Do NOT modify any file.
```

Two things then work:

- **You run it**: `/reviewer grade the diff on this branch` dispatches it immediately, with no
  round trip through the main model to decide whether to.
- **The model runs it**: your `description` is what it reads to decide when to delegate, so "have
  someone check this before I push" can reach the same agent on its own.

The format is the one Cursor and Claude Code already use, so existing agent files work when you
copy them into `.seri/agents/`. seri does not read `.cursor/agents/` or `.claude/agents/` itself:
an agent written for another harness's toolset auto-loading here is a surprise, not a convenience.

A few rules worth knowing. Omit `tools` and the agent gets every tool seri has, the same grant the
built-in `code` agent holds; `readonly: true` restricts it to reading. A subagent can never
dispatch further subagents — that is structural, not a rule it is asked to follow. A file that
does not parse, or that takes the name of a built-in agent or a slash command, is skipped with a
warning at startup rather than failing the session. And `/explore`, `/plan`, `/code`, `/test` and
`/oracle` work the same way, because the built-in roster is entries in the same registry.

## Project rules

A rule is a standing instruction rather than something you invoke. Drop one in
`.seri/rules/<name>.mdc` (this project) or your profile root (every project) — `~/.seri/rules/` by default,
`~/.seri/<profile>/rules/` under `--profile <name>`. Frontmatter decides when it loads.

```markdown
---
description: TypeScript conventions for this repo.
globs: "**/*.{ts,tsx}"
alwaysApply: false
---

Make illegal states unrepresentable. Parse external data at the boundary.
```

`alwaysApply: true` puts the rule in the prompt for the whole session, next to `AGENTS.md`.

`globs` makes it conditional on what the session actually touches. The rule stays out of the prompt
until a `read_file` or `write_file` lands on a matching path, and then it arrives as a note in the
conversation — once per session, not once per file. Matching a `read_file` is deliberate: it puts
the rule in front of the model *before* it composes the edit.

**The rule text never enters the system prompt mid-session.** That string is frozen when the
session starts, and keeping it frozen is what lets a provider reuse its cached prefix for every
turn. A rule that fires appends to the conversation instead, which is where every tool result
already goes.

A rule with only a `description` and neither of the other two loads nothing today, and says so at
startup naming the file. A file setting both `globs` and `alwaysApply: true` is always-on, and is
never also injected per touch. Patterns accept `**`, braces and ranges; a comma-separated list is
several patterns, while commas inside `{…}` stay part of one. Paths are matched relative to the
worktree, with separators normalised, so `src/**` means the same thing on Windows, macOS and Linux.

Rules are human-authored, like `AGENTS.md`. seri never writes one.

## Your own skills

A skill is a procedure rather than a role: a named set of instructions that runs in the session's
own context instead of a subagent's. Drop one in `.seri/skills/<name>/SKILL.md` (this project) or
under your profile root (every project) — `~/.seri/skills/` by default, `~/.seri/<profile>/skills/`
under `--profile <name>`, with no fallback between them.

```markdown
---
name: regression-sweep          # optional — the directory name is the default
description: Reproduce a bug, write the failing test, then fix it.
argument-hint: "<bug description>"
disable-model-invocation: true  # optional — only you can run it, never the model
---

Fix this bug: $ARGUMENTS

1. Reproduce it and record the exact steps.
2. Write the failing test first.
3. Fix it, then run the suite.
```

Two things then work, the same two that work for an agent:

- **You run it**: type `/` and the name. The completion list shows every command, agent and skill
  with what each one does, so you do not have to remember the exact name.
- **The model runs it**: your `description` is what it reads to decide when a task calls for this
  procedure.

**A skill's instructions are never in the prompt.** Session start pays for the name, the
description and the argument hint; the body stays on disk until the skill actually fires, so a
directory of twenty skills costs twenty descriptions, not twenty procedures. `/skills` opens a panel listing what this session loaded, where each file lives,
and who wrote it.

`$ARGUMENTS` substitutes everything you typed after the name; `$0`, `$1`, `$2` substitute the
individual words. `disable-model-invocation: true` keeps a skill out of the prompt and out of the
model's reach entirely, leaving `/name` as its only entry point. The format is Cursor's, so
existing `SKILL.md` files work when you copy them in — seri does not read `.cursor/skills/` itself,
for the same reason it does not read `.cursor/agents/`. `allowed-tools`, `model` and `context` are
accepted and ignored, with a warning naming the file: a skill runs in the parent's context, on the
parent's model, with the parent's tools.

**Skills are the one artifact seri writes for you.** After hard-won work, the archivist can propose
one — it is staged, never applied: `/skills pending` lists what is waiting, `/skills diff <id>`
shows the exact file, and `/skills approve <id>` writes it. An approved file carries
`author: archivist` and the reason it was proposed, so you can always tell which of your skills you
wrote and which one seri did.

## Hooks

A hook is a rail rather than an instruction. It is a script seri runs at a fixed point in the loop,
outside the model's control, so what it enforces is a guarantee instead of a request. Blocking a
`git push --force`, formatting a file the moment it is written, and keeping an audit log are the
three things it is for.

Put a manifest at `.seri/hooks/hooks.yaml` (this project) or under your profile root (every
project) — `~/.seri/hooks/` by default, `~/.seri/<profile>/hooks/` under `--profile <name>`.

```yaml
hooks:
  PreToolUse:
    - script: block-dangerous
      matcher: bash|powershell
  PostToolUse:
    - script: format-on-edit
      matcher: write_file|edit
      timeout: 10
```

`script` is a bare name, and the file beside it is `block-dangerous.ps1` on Windows and
`block-dangerous.sh` everywhere else. **Write both halves.** seri runs the one for the platform it
is on and warns at startup, naming the file and the platform, if it is missing — a hook that would
silently not run on a teammate's machine says so instead.

`matcher` is a regular expression over the tool name, anchored at both ends, so `edit` means the
`edit` tool and not the tail of something else. Omit it and the hook runs for every tool.
`mcp_github_.*` scopes a hook to one MCP server. `timeout` is in seconds, 30 by default.

**A matcher names a tool, not an intent.** A hook matching only `read_file` blocks `read_file`, and
the model is free to reach the same file with `grep` or `bash` instead — observed, not theorised.
If what you mean to protect is a path or a secret rather than one tool, match every tool that could
get there (`read_file|grep|bash|powershell`), or leave `matcher` out and let the script decide from
the payload.

seri sends the script a JSON payload on stdin and reads its exit code:

| exit | meaning |
| --- | --- |
| `0` | allow. |
| `2` | **block.** Whatever the script printed on stderr becomes the reason the model is told. |
| anything else | the hook could not run. It is reported, and the call proceeds. |

```bash
#!/usr/bin/env bash
payload=$(cat)
if grep -q 'rm -rf /' <<<"$payload"; then
  echo "BLOCKED: rm -rf /" >&2
  exit 2
fi
```

A `PreToolUse` block runs **before** the permission gate, so no mode reaches around it: `auto` and
`--dangerously-skip-permissions` are blocked exactly as `approve-each` is, and you are never asked
to approve a call a hook is about to refuse. `PostToolUse` runs after the tool, where exit 2 has
nothing left to stop, so it is reported like any other failure.

A broken hook never takes the session down. It fails open, loudly: the call proceeds and the error
lands in the transcript. That is deliberate — a typo in a formatter should not stop you working.

The contract is Claude Code's and Cursor's, unchanged, so scripts written for either run here when
you copy them into `.seri/hooks/`. seri does not read `.cursor/hooks/` itself, for the same reason
it does not read `.cursor/agents/`.

### Hooks from a repository you cloned do not run until you say so

This is the one extension seri will not load on sight. Rules and skills carry text; a hook carries
a program, and it runs in front of the permission gate on tools that never prompt, which means an
untrusted one would be code execution from a `git clone` with nothing asked of you first.

So: hooks in **your own profile root** run, because nothing arrives there by cloning anything. A
project's `.seri/hooks/` is found, listed, and left dormant until you review it. Session start says
so, naming the directory. `/hooks` shows the wiring and every script in full, and `/hooks trust`
turns them on.

Trust is bound to the bytes you read, not to the path. Edit any file in the directory, or pull a
change to one, and the hooks stop running until you look at what moved and trust it again.
Scheduled runs load no hooks at all, trusted or not.

## Checking your code after a write

seri can run your project's own check command after every successful `write_file` and hand the
diagnostics back to the model in the same turn, so a type error it just introduced is visible
while it is still working on that file.

This is **off until you set a command**, via `/config` — seri does not look inside your
repository for one. `SERI_VERIFY_COMMAND` and `SERI_VERIFY_ENABLED` work as environment variables
too, taking precedence over whatever `/config` has stored:

| key | meaning |
| --- | --- |
| `SERI_VERIFY_COMMAND` | the command to run. Unset means no checking, and nothing is spawned. |
| `SERI_VERIFY_ENABLED` | set to `false` to suspend checking without unsetting the command. |

What to expect before you turn it on:

- **It runs after every successful write**, so the cost is per write, not per session. Measured on
  this repo, `bun run --cwd apps/cli typecheck` takes about 3.6 s — that is 3.6 s added to every
  file the model writes. A slower project check costs proportionally more.
- **It runs in the directory you started seri in**, and the command is split on whitespace, so
  quoted arguments and paths containing spaces are not supported.
- **Diagnostics are advisory.** The write is not rolled back. Use `/undo` for that.
- **It reports whatever your command reports**, usually the whole project — including errors that
  were already there before seri touched anything. Diagnostics in the file just written are listed
  first, and at most 20 are sent to the model, with the true total alongside.

## Where this is going

seri's design deliberately extracts the strongest mechanism from each major agent harness
rather than cloning one wholesale, and commits to an explicit verdict on every mechanism it
considers rather than leaving the choice implicit. Two directions aren't built yet: an
OS-level sandbox layered on top of the permission gate, upgrading it rather than replacing
it, and an offline pipeline that turns recorded trajectories into a reviewable, per-project
behavioral policy. That second one is deliberately not "self-evolving" or autonomous — every
promotion requires a human to approve it, the same way memory writes do today.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to get the repo running and what a change
needs to clear before it lands.

## License

[Apache License 2.0](./LICENSE). Copyright 2026 Seriora Research.
