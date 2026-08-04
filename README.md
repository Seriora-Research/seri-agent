# seri

A cross-platform coding-agent CLI. seri ships as a single `seri` binary — no runtime
to install — and is written in TypeScript on [Bun](https://bun.com).

## Install

### macOS

```sh
curl -fsSL https://raw.githubusercontent.com/lzvxck/seri-agent/main/install.sh | bash
```

### Linux

```sh
curl -fsSL https://raw.githubusercontent.com/lzvxck/seri-agent/main/install.sh | bash
```

Installs to `~/.local/bin`. If that directory isn't on your `PATH`, the script prints the
line to add — it never edits your shell config for you.

### Windows

```powershell
irm https://raw.githubusercontent.com/lzvxck/seri-agent/main/install.ps1 | iex
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

`seri --version` prints the installed version.
