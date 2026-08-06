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

`seri --help` prints the usage text, and `seri --version` the installed version.

The first search of each release unpacks its bundled ripgrep to `%LOCALAPPDATA%\seri\rg\<key>\`
on Windows, or `~/.seri/rg/<key>/` elsewhere. Deleting that directory is safe — the next search
writes it again — and a run that cannot write there falls back to a temporary copy.

## License

[Apache License 2.0](./LICENSE). Copyright 2026 Seriora Research.
