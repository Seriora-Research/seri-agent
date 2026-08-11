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

Installs to `~\.seri\bin` and adds it to your user `PATH`. No admin rights
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

The default model is `openai/gpt-oss-120b` on Groq, chosen by measurement: on the same task, the
same prompt and a fresh session each run, it made a real tool call in 20 of 20 runs where
`llama-3.3-70b-versatile` managed 5 of 11. Set the `SERI_MODEL` env var for any other Groq model
id. `seri config set SERI_MODEL <id>` works too, with the env var winning, but `seri config list`
masks what it prints like an API key — `openai/gpt-oss-120b` reads back as `open...120b`, and an id
of 12 characters or fewer as nothing but asterisks. The model is recorded on the session the first
time the provider answers on it, so `--continue` keeps using the one that session has been running
— and a mistyped id, which never gets that far, is never recorded: fix `SERI_MODEL` and
`--continue` picks up the correction.

Sessions from before seri recorded the model at all are the one exception: they ran
`llama-3.3-70b-versatile`, nothing in the file says so, and the first `--continue` after upgrading
moves them onto whatever `SERI_MODEL` resolves to and records that from then on.

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
succeeds now becomes the default for every future brand-new session**, not just the one you picked
it in — it writes `SERI_MODEL`/`SERI_PROVIDER` to `config.json` the same way `seri config set`
would. A session that never touches `/model` never writes either key.

Inside the TUI, `/setup` is the interactive equivalent of the `seri config set` calls above — it
lists all five providers, masks whatever is already stored, and lets you add, replace or remove a
key without leaving the session. A typed key is checked with one minimal, near-free API call before
it's saved; only an actual auth failure (401/403) is rejected, everything else stores the key
anyway with a warning, since a network hiccup shouldn't be the thing that stops you from saving a
key at all.

If a model is reachable through more than one provider (a model available both directly from
Anthropic and through OpenRouter, say) and the pair you're on has no key, `seri` reroutes to
whichever configured provider reaches the same model — native providers preferred over an
aggregator like OpenRouter — and says so once in the transcript. An explicit `/model` pick always
wins over this if its own provider has a key. `/model`'s own picker groups every route to the same
model together so you can see which ones are reachable.

`seri --help` prints the usage text, and `seri --version` the installed version.
`seri --continue` resumes the most recent session, and `seri --resume <id>` a named one; a task
containing a flag goes after `--` (`seri -- fix the --help output`).

The first search of each release unpacks its bundled ripgrep to `~/.seri/rg/<key>/`. Deleting that
directory is safe — the next search writes it again — and a run that cannot write there falls back
to a temporary copy.

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
