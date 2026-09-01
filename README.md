# seri

[![CI](https://github.com/lzvxck/seri-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/lzvxck/seri-agent/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/lzvxck/seri-agent)](./LICENSE)

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
  plus user-defined agents in `.seri/agents/`.
- **Persistent memory.** After a turn, an archivist can stage facts to `MEMORY.md`/`USER.md`
  outside the repo. `/memory` reviews them; nothing is applied silently.
- **Six providers, three ways to pay.** Groq, OpenRouter, Anthropic, OpenAI, Google, and xAI —
  with a BYOK key, a hosted seri account (`/login`), or a Grok / ChatGPT (Codex) subscription
  connected from `/setup`.
- **Extensibility without a source change.** Skills, rules, hooks, and MCP servers are files you
  drop in a directory.
- **Verify after write.** Point seri at your project's check command via `/config` and it runs
  after every successful write, feeding diagnostics back in the same turn.
- **Profiles and compaction.** `/profile` isolates config, memory, and sessions.
  `/compact [instructions]` summarizes older messages so the conversation fits the context
  window. Local trajectory recording (`/trajectory`) is on by default — the research substrate,
  not an evolution loop.

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

That opens the TUI. On a first run, guided setup asks how you want to pay for models: a
provider API key, a hosted seri account (`/login` / `/signup`), or a Grok or ChatGPT
subscription from `/setup`. Setting the matching environment variable before you launch
(`GROQ_API_KEY`, say) works too.

`/model` switches provider and model mid-session without losing context. A pick whose next
turn succeeds becomes the default for future sessions. If the pair you're on has no key, seri
reroutes to a configured provider that reaches the same model — native providers preferred
over an aggregator — and says so once in the transcript.

| provider | key |
| --- | --- |
| Groq | `GROQ_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google | `GOOGLE_GENERATIVE_AI_API_KEY` |
| xAI | `XAI_API_KEY` |

`SERI_PROVIDER` names which of the six `SERI_MODEL` is read against.

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
| `/usage` | hosted-gateway spend vs allowance |
| `/exit` | end the session (or Ctrl-D) |
| `/model` | open the model picker across all six providers |
| `/setup` | add, replace, or remove a provider key; connect a subscription |
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
