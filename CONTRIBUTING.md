# Contributing to seri

This repository is the `seri` CLI. This document covers how to get it running and
what a change needs to clear before it can land.

## Setup

You need [Bun](https://bun.com) 1.3.14 or later. Nothing else — no Node, no global tooling.

```sh
git clone https://github.com/Seriora-Research/seri-agent.git
cd seri-agent
bun install
```

`postinstall` fetches a vendored ripgrep binary into `apps/cli/src/tools/`. It's a build
artifact — don't commit changes to it.

## Layout

Bun workspace.

| Path | What it is |
| --- | --- |
| `apps/cli` | the `seri` binary |
| `packages/daemon-client` | loopback daemon protocol client |
| `packages/model-catalog` | models.dev catalog + routing keys |
| `packages/plans` | hosted-plan labels and quota copy the CLI prints |
| `patches/` | Bun patches (OpenTUI) |

[AGENTS.md](./AGENTS.md) is the architecture: loop/CLI boundary, permission gate, tools,
sessions, compaction, checkpoints, auth. Read it before changing `apps/cli`.

## Commands

```sh
bun run dev -- <args>       # run the CLI from source
bun test                    # the whole suite
bun test path/to/file.test.ts
bun run typecheck           # tsc --noEmit (aliased as `lint`)
bun run build               # compile to apps/cli/dist/seri for this platform
```

## Before you open a PR

```sh
bun run typecheck
bun test
bun run build && ./apps/cli/dist/seri --version
```

On Windows the binary is `apps/cli/dist/seri.exe`.

CI runs typecheck, test, and build on **Linux, macOS, and Windows**. Treat all three
as required, not just the OS you are on.

**If the change touches file paths, file I/O, process spawning, signals, or shell
invocation, verify it on both a POSIX shell and PowerShell.** seri ships two shells
with no translation layer, and resolves config, session, and checkpoint paths per
platform. If you only have one OS, say so in the PR and let CI cover the rest.

Keep a PR to one logical change.

## Branches and commits

`main` is protected. Work lands through a branch and a pull request.

Branch prefixes: `feat/`, `fix/`, `docs/`, `test/`, `refactor/`, `chore/`.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

feat(checkpoint): warn once per session on a project with no .gitignore
fix(config): fold the store key's case on darwin too, not just win32
```

Scopes in use: `cli`, `loop`, `gate`, `tools`, `config`, `session`, `checkpoint`,
`auth`, `tui`, `install`, `ci`.

## Tests

Bun's built-in runner. Tests live in `tests/` or next to the code as `*.test.ts`.

Tools are pure functions — a change to `read_file`, `edit`, `grep`, or `glob` should
come with a test that does not need an API key. A bugfix should come with a test that
fails before it and passes after.

## Reporting bugs

Open an issue using the bug report form. Include `seri --version`, your OS and shell,
and the steps to reproduce.

For anything with security impact, **don't open an issue** — see
[SECURITY.md](./SECURITY.md).

## Licensing of contributions

By contributing, you agree that your contributions are licensed under the license in
[LICENSE](./LICENSE).

## Code of conduct

Participation is governed by the [Code of Conduct](./CODE_OF_CONDUCT.md).
