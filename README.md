# seri

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

## What's here today

- **A TUI and a non-interactive mode on the same loop.** Run `seri "task"` for a single
  scripted turn, or run `seri` with no arguments in a terminal to open the interactive TUI —
  same engine either way.
- **A permission gate as the base safety layer**, on every OS: `read-only` / `approve-each` /
  `auto`, one keystroke to cycle (`/mode`). A tool you approve with "always" is remembered —
  for `write_file`/`edit` that persists across runs (`seri permissions list|remove`).
- **Checkpoints, undo, and rewind.** Every filesystem-mutating tool call commits to a shadow
  git ref, independent of your own branch. `/undo [n]`, `/rewind [n]`, `/restore <sha>` walk it
  back without touching your commit history.
- **Subagents.** The model can dispatch named, isolated-context roles (`explore`, `plan`,
  `code`, `test`) for parts of a task that benefit from their own context window.
- **Persistent memory.** After a turn, an `archivist` role can write facts it learned to
  `MEMORY.md`/`USER.md` outside the repo. Writes are staged for approval by default
  (`/memory pending|diff|approve|reject`), never applied silently, and can be turned off
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

Set `SERI_VERSION=<tag>` to install a specific release instead of the latest one.

## Getting started

```sh
seri config set GROQ_API_KEY <your-key>
seri "explain what this repo does"
```

Run `seri` with no task in a terminal instead, and it opens the TUI with an empty input box —
the same loop, driven interactively, with slash commands (below) in place of flags.

The default model is `openai/gpt-oss-120b` on Groq, chosen by measurement: on the same task, the
same prompt and a fresh session each run, it made a real tool call in 20 of 20 runs where
`llama-3.3-70b-versatile` managed 5 of 11. Set the `SERI_MODEL` env var for any other Groq model
id. `seri config set SERI_MODEL <id>` works too, with the env var winning, but `seri config list`
masks what it prints like an API key — `openai/gpt-oss-120b` reads back as `open...120b`, and an id
of 12 characters or fewer as nothing but asterisks. The model is recorded on the session the first
time the provider answers on it, so `--continue` keeps using the one that session has been running
— and a mistyped id, which never gets that far, is never recorded: fix `SERI_MODEL` and
`--continue` picks up the correction.

Anthropic, OpenAI and Google work the same BYOK way as Groq and OpenRouter — set the matching key
and pick a model:

```sh
seri config set ANTHROPIC_API_KEY <your-key>
seri config set OPENAI_API_KEY <your-key>
seri config set GOOGLE_GENERATIVE_AI_API_KEY <your-key>
```

`SERI_PROVIDER` names which of the five (`groq`, `openrouter`, `anthropic`, `openai`, `google`)
`SERI_MODEL` should be read against; it defaults to `groq` and follows the same
env-beats-config precedence as every other key here. **A `/model` pick whose next turn actually
succeeds becomes the default for every future brand-new session**, not just the one you picked
it in — it writes `SERI_MODEL`/`SERI_PROVIDER` to `config.json` the same way `seri config set`
would. A session that never touches `/model` never writes either key.

If a model is reachable through more than one provider (a model available both directly from
Anthropic and through OpenRouter, say) and the pair you're on has no key, `seri` reroutes to
whichever configured provider reaches the same model — native providers preferred over an
aggregator like OpenRouter — and says so once in the transcript. An explicit `/model` pick always
wins over this if its own provider has a key.

`seri --help` prints the usage text, and `seri --version` the installed version.
`seri --continue` resumes the most recent session, and `seri --resume <id>` a named one; a task
containing a flag goes after `--` (`seri -- fix the --help output`).

The first search of each release unpacks its bundled ripgrep to `~/.seri/rg/<key>/`. Deleting that
directory is safe — the next search writes it again — and a run that cannot write there falls back
to a temporary copy.

## Inside the TUI

Everything below has a non-interactive `seri <subcommand>` equivalent for scripting; run
`seri --help` for the full list.

| Command | Does |
| --- | --- |
| `/mode` | cycle the permission mode: `read-only` → `approve-each` → `auto` |
| `/model` | open the model picker, across all five providers and every route to a given model |
| `/setup` | add, replace, or remove a provider API key without leaving the session |
| `/config` | view or edit non-provider settings (e.g. the verify command) |
| `/permissions` | view or revoke tools you've permanently approved |
| `/undo [n]`, `/rewind [n]`, `/restore <sha>` | step back through checkpoints |
| `/memory pending\|diff\|approve\|reject` | review and act on staged memory writes |
| `/memory archivist on\|off` | turn the post-turn learning pass off entirely |
| `/login`, `/signup`, `/logout` | sign in to, create, or leave a hosted seri account |
| `/profile new <name>` | create a new profile — an isolated config/memory/session root |
| `/max-turns <n>` | override the per-task turn budget (default 500) for the rest of the session |
| `/exit` | end the session (or Ctrl-D) |

`--dangerously-skip-permissions` runs every tool with no approval prompt, for that run only —
attended use only, and never written back to a session.

## Checking your code after a write

seri can run your project's own check command after every successful `write_file` and hand the
diagnostics back to the model in the same turn, so a type error it just introduced is visible
while it is still working on that file.

This is **off until you set a command**. seri does not look inside your repository for one.

```sh
seri config set SERI_VERIFY_COMMAND "bun run typecheck"
```

Both keys can also be set as environment variables, which take precedence over `config set`:

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
- **Diagnostics are advisory.** The write is not rolled back. Use `seri /undo` for that.
- **It reports whatever your command reports**, usually the whole project — including errors that
  were already there before seri touched anything. Diagnostics in the file just written are listed
  first, and at most 20 are sent to the model, with the true total alongside.

## Where this is going

`docs/ARCHITECTURE.md` surveys the strongest mechanisms across the major agent harnesses —
Claude Code, Codex, opencode, Aider, Hermes, and others — and records an explicit verdict on
each rather than picking one to follow. Two directions from that survey aren't built yet: an
OS-level sandbox layered on top of the permission gate (bubblewrap/Seatbelt, upgrading the
gate rather than replacing it), and an offline pipeline (`docs/EVOLUTION.md`) that turns
recorded trajectories into a reviewable, per-project behavioral policy. That document is
deliberately careful about what to call the second one: the claim is "policy learned from a
corpus of trajectories, validated against a human-written baseline," not an autonomous or
self-modifying harness — every promotion still requires a human to approve it, the same way
memory writes do today. `docs/ROADMAP.md` tracks what's actually shipped against what's next.

## License

[Apache License 2.0](./LICENSE). Copyright 2026 Seriora Research.
