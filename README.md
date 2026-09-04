# seri

[![CI](https://github.com/Seriora-Research/seri-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Seriora-Research/seri-agent/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/Seriora-Research/seri-agent)](./LICENSE)

seri is a cross-platform coding-agent CLI. It ships as a single `seri` binary — no runtime to
install — written in TypeScript on [Bun](https://bun.com), and runs natively on Windows, macOS,
and Linux (no WSL2 or Docker required).

It is a research-oriented harness, working on self-evolving harnesses: recorded trajectories
become reviewable per-project policy, with a human on every promotion. That pipeline is not
shipped. Evaluate seri today as a coding agent.

seri is **code-first, not code-only**. Coding is what it does today, and the only thing this
release is built for. The loop, the session store, and the permission model are not bounded to a
repository; general assistant work is a planned direction.

## What it does

- **A permission gate** as the base safety layer, on every OS: `read-only` / `approve-each` /
  `auto`, cycled with `/mode`. Approving a tool "always" is scoped to that tool — for
  `write_file`/`edit` it persists across sessions.
- **Checkpoints, undo, rewind, restore.** Filesystem-mutating tool calls commit to a shadow git
  ref, independent of your branch. `/undo`, `/rewind`, and `/restore` walk it back without
  touching your commit history.
- **Subagents.** Built-in isolated-context roles (`explore`, `plan`, `code`, `test`, `oracle`)
  plus user-defined agents in `.seri/agents/`. Dispatch with `/explore <task>` or let the model
  pick one.
- **Persistent memory.** After a turn, an archivist can stage facts to `MEMORY.md`/`USER.md`
  outside the repo. `/memory` reviews them; nothing is applied silently.
- **Six providers in one harness.** Groq, OpenRouter, Anthropic, OpenAI, Google, and xAI.
  Switch with `/model` mid-session without losing context.
- **Three ways to pay, including consumer subscriptions.** A BYOK API key, a hosted seri
  account (`/login`), or a **Grok** or **ChatGPT (Codex)** subscription from `/setup`. Keys and
  subscriptions live side by side in the same session.
- **Extensibility without a source change.** Agents, skills, rules, MCP servers, and hooks are
  files you drop in `.seri/` (this project) or under your profile (every project).
- **Verify after write.** Point seri at your project's check command via `/config` and it runs
  after every successful write, feeding diagnostics back in the same turn.
- **Sessions, profiles, compaction.** `--continue` / `--resume <id>` reopen a conversation.
  `/profile` isolates config, memory, and sessions. `/compact [instructions]` summarizes older
  messages so the conversation fits the context window. Local trajectory recording
  (`/trajectory`) is on by default — the research substrate, not an evolution loop.
- **A local daemon.** `seri serve` starts a loopback daemon for the profile; `seri exec <task>`
  runs one task through it.

## Providers and how you pay

The **provider** is the API surface. The **credential** is what pays. They are separate on
purpose: the same model can be reached by a key, a subscription, or a hosted account.

| Provider | Id | BYOK key |
| --- | --- | --- |
| Groq | `groq` | `GROQ_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai` | `OPENAI_API_KEY` |
| Google | `google` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| xAI | `xai` | `XAI_API_KEY` |

The provider is spelled `xai`, not `grok`. Grok is the model family; xAI is the company that
serves it.

| How you pay | What it is |
| --- | --- |
| **Key** | your own API key for that provider (`/setup`, or the env var above) |
| **Subscription** | a plan you already pay for — **seri** (`/login`, free / pro / max / ultra), **Grok** (SuperGrok / X Premium+) on xAI, or **ChatGPT / Codex** on OpenAI |
| **Hosted** | the seri plan above: a seri account that routes on your behalf |

`/setup` lists API keys and Subscriptions in one panel. seri, Grok, and Codex each appear as
their own subscription row. Connect a Grok plan with a browser sign-in. Connect a ChatGPT plan
by logging in with the Codex CLI (`codex login`); seri reads that login and does not host its
own ChatGPT OAuth. Disconnect is local to this profile and leaves the login in place so you
can switch back to the plan or to your own keys.

A subscription and a metered key can both be present. For that vendor the subscription wins, and
the key is marked unused. Turns on a subscription report `(cost: included)` instead of a dollar
amount. seri never silently falls back from a refused subscription to a key that would charge
you.

`/model` lists every provider and every route to a given model, including plan-included rows.
A pick whose next turn succeeds becomes the default for future sessions. If the pair you're on
has no credential, seri reroutes to a configured provider that reaches the same model — native
providers preferred over an aggregator — and says so once in the transcript.

`SERI_PROVIDER` names which of the six `SERI_MODEL` is read against.

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
platform from [Releases](https://github.com/Seriora-Research/seri-agent/releases), make it
executable, and put it somewhere on your `PATH`. Both install scripts are short enough to
read first, and both verify the download against the `SHA256SUMS` file published with each
release — that catches a truncated or corrupted download, not a compromised release.

## Getting started

```sh
seri
```

That opens the TUI. On a first run, guided setup asks how you want to pay: paste a provider
key and pick a model, or connect a seri, Grok, or ChatGPT (Codex) subscription from `/setup`.
Signing into a hosted account on the welcome splash (`Log in` / `Sign up`) skips setup — the
seri plan covers OpenRouter without a local key, and `/setup` lists it under Subscriptions
with the plan name (free / pro / max / ultra). OpenRouter stays a normal API-key row for a
key you bring yourself. Disconnecting the seri plan (without `/logout`) switches this
profile back to your keys. Setting a key in the environment before you launch
(`GROQ_API_KEY` or `XAI_API_KEY`, say) also skips setup.

```text
seri <task>                   one-shot, non-interactive
seri --continue [task]        reopen the most recent session
seri --resume <id> [task]     reopen that session
seri serve                    start the loopback daemon for this profile
seri exec <task>              run one task through an already-running daemon
```

`--profile <name>` (or `SERI_PROFILE`) puts config, auth, permissions, sessions, and checkpoints
under an isolated root.

## Commands

Everything below is a slash command inside the session.

| Command | Does |
| --- | --- |
| `/mode` | cycle permission mode: `read-only` → `approve-each` → `auto` |
| `/effort` | show, set, or clear this session's reasoning-effort override |
| `/undo` | step back through file checkpoints |
| `/restore` | restore a checkpoint by sha |
| `/rewind` | rewind the conversation |
| `/clear` | start a new session (previous one stays recoverable with `seri --resume <id>`) |
| `/compact [instructions]` | summarize older messages so the conversation fits the context window |
| `/memory` | review staged memory writes |
| `/trajectory` | show or turn local trajectory recording on or off |
| `/usage` | hosted allowance used |
| `/exit` | end the session (or Ctrl-D) |
| `/model` | open the model picker across all six providers and subscription routes |
| `/setup` | add or replace a provider API key; connect or ignore seri, Grok, or Codex plans |
| `/login` | sign in to a hosted seri account |
| `/signup` | create a hosted seri account |
| `/logout` | leave a hosted seri account |
| `/config` | view or edit non-provider settings (including the verify command) |
| `/permissions` | view or revoke permanently approved tools |
| `/skills` | list skills, and review what the archivist proposed |
| `/mcp` | manage MCP servers |
| `/hooks` | read this project's hooks and decide whether they may run |
| `/max-turns` | override the per-task turn budget (default 500) |
| `/profile` | create a new profile — an isolated config/memory/session root |
| `/<agent> <task>` | dispatch a built-in or user-defined subagent |
| `/<skill> [args]` | run a skill in the session's own context |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to get the repo running and what a change
needs to clear before it lands.

## License

[Apache License 2.0](./LICENSE). Copyright 2026 Seriora Research.
