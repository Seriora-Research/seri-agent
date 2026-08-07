# seri

A cross-platform coding-agent CLI. seri ships as a single `seri` binary — no runtime
to install — and is written in TypeScript on [Bun](https://bun.com).

## Scope

seri is **code-first, not code-only**. Coding is what it does today, and it is the only
thing this release is built for — the tools it ships are file, search, and shell tools.

The design is deliberately not bounded by that. The loop, the session store, and the
permission model assume no repository, and general assistant work is a planned direction.
It is a direction, not a shipped feature: **evaluate seri today as a coding agent.**

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

Installs to `%LOCALAPPDATA%\seri\bin` and adds it to your user `PATH`. No admin rights
required. Open a new terminal afterwards so the `PATH` change takes effect.

### Without piping to a shell

If you'd rather not run a script straight from the internet, download the binary for your
platform from [Releases](https://github.com/lzvxck/seri-agent/releases), make it
executable, and put it somewhere on your `PATH`. Both install scripts are short enough to
read first, and both verify the download against the `SHA256SUMS` file published with each
release — that catches a truncated or corrupted download, not a compromised release.

Set `SERI_VERSION=v0.1.0` to install a specific release instead of the latest one.

## Getting started

```sh
seri config set GROQ_API_KEY <your-key>
seri "explain what this repo does"
```

The default model is `openai/gpt-oss-120b`, chosen by measurement: on the same task, the same
prompt and a fresh session each run, it made a real tool call in 20 of 20 runs where
`llama-3.3-70b-versatile` managed 5 of 11. Set the `SERI_MODEL` env var for any other Groq model
id. `seri config set SERI_MODEL <id>` works too, with the env var winning, but `seri config list`
masks every value it prints — it is built for API keys — so an id stored that way reads back as
asterisks. The model is recorded on the session when it is created, so `--continue` keeps using the
one that session started with — which also means a mistyped id sticks to that session. Correct
`SERI_MODEL` and start a new session (any plain `seri "task"` does); the typo only follows you if
you keep resuming the session it was recorded on.

Sessions from before seri recorded the model at all are the one exception: they ran
`llama-3.3-70b-versatile`, nothing in the file says so, and the first `--continue` after upgrading
moves them onto whatever `SERI_MODEL` resolves to and records that from then on.

`seri --help` prints the usage text, and `seri --version` the installed version.
`seri --continue` resumes the most recent session, and `seri --resume <id>` a named one; a task
containing a flag goes after `--` (`seri -- fix the --help output`).

The first search of each release unpacks its bundled ripgrep to `%LOCALAPPDATA%\seri\rg\<key>\`
on Windows, or `~/.seri/rg/<key>/` elsewhere. Deleting that directory is safe — the next search
writes it again — and a run that cannot write there falls back to a temporary copy.

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

## License

[Apache License 2.0](./LICENSE). Copyright 2026 Seriora Research.
