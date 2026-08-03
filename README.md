# Hesper

A cross-platform coding-agent CLI. Hesper ships as a single `hesper` binary — no runtime
to install — and is written in TypeScript on [Bun](https://bun.com).

## Install

### macOS

```sh
curl -fsSL https://raw.githubusercontent.com/lzvxck/hesper-code/main/install.sh | bash
```

### Linux

```sh
curl -fsSL https://raw.githubusercontent.com/lzvxck/hesper-code/main/install.sh | bash
```

Installs to `~/.local/bin`. If that directory isn't on your `PATH`, the script prints the
line to add — it never edits your shell config for you.

### Windows

```powershell
irm https://raw.githubusercontent.com/lzvxck/hesper-code/main/install.ps1 | iex
```

Installs to `%LOCALAPPDATA%\hesper\bin` and adds it to your user `PATH`. No admin rights
required. Open a new terminal afterwards so the `PATH` change takes effect.

### Without piping to a shell

If you'd rather not run a script straight from the internet, download the binary for your
platform from [Releases](https://github.com/lzvxck/hesper-code/releases), make it
executable, and put it somewhere on your `PATH`. Both install scripts are short enough to
read first, and both verify the download against the `SHA256SUMS` file published with each
release — that catches a truncated or corrupted download, not a compromised release.

Set `HESPER_VERSION=v0.1.0` to install a specific release instead of the latest one.

## Getting started

```sh
hesper config set GROQ_API_KEY <your-key>
hesper "explain what this repo does"
```

`hesper --version` prints the installed version.
