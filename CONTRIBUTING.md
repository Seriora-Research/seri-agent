# Contributing to seri

Thanks for taking the time. This document covers how to get the repo running, and what a
change needs to clear before it can land.

## Setup

You need [Bun](https://bun.com) 1.3.14 or later. Nothing else — no Node, no global tooling.

```sh
git clone https://github.com/lzvxck/seri-agent.git
cd seri-agent
bun install
```

`postinstall` fetches a vendored ripgrep binary into `apps/cli/src/tools/`. It's a build
artifact — don't commit changes to it.

## Layout

This is a Bun workspace monorepo.

| Path            | What it is                                            |
| --------------- | ----------------------------------------------------- |
| `apps/cli`      | the `seri` CLI — the agent itself                     |
| `apps/server`   | hosted accounts and billing                           |
| `apps/web`      | the marketing site, which also serves the installers  |
| `apps/lab`      | a separate site                                       |
| `packages/ui`   | React components shared by the sites                  |

[AGENTS.md](./AGENTS.md) documents the CLI's architecture — the loop/CLI boundary, the
permission gate, tools, sessions, compaction, checkpoints, auth. Read it before changing
anything in `apps/cli`; several of its constraints are load-bearing and not obvious from
the code alone.

## Commands

```sh
bun run dev -- <args>       # run the CLI from source
bun run dev:server          # run apps/server
bun test                    # the whole suite
bun test path/to/file.test.ts
bun run typecheck           # tsc --noEmit (aliased as `lint`)
bun run build               # compile to apps/cli/dist/seri for this platform
```

## Before you open a PR

Run all three, and run the binary you built:

```sh
bun run typecheck
bun test
bun run build && ./apps/cli/dist/seri --version
```

CI runs the same three on **Linux, macOS and Windows** for every push and PR. Treat all
three platforms as required, not just the one you're on — most regressions in this repo
have been platform-specific rather than logical.

**If your change touches file paths, file I/O, process spawning, signals, or shell
invocation, verify it on both a POSIX shell and PowerShell.** seri ships two separate
shells with no translation layer between them, and resolves config, session and
checkpoint paths differently per platform. This is where the bugs are. If you only have
one OS, say so in the PR and let CI cover the rest — just don't claim a platform you
didn't run.

Keep a PR to one logical change. A refactor bundled with a fix is two PRs.

## Branches and commits

`main` is protected: work lands through a branch and a pull request, never a direct push.

Branch prefixes: `feat/`, `fix/`, `docs/`, `test/`, `refactor/`, `chore/`.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

feat(checkpoint): warn once per session on a project with no .gitignore
fix(config): fold the store key's case on darwin too, not just win32
```

Scopes in use: `cli`, `loop`, `gate`, `tools`, `config`, `session`, `checkpoint`, `auth`,
`server`, `web`, `ui`, `install`, `ci`.

## Tests

Bun's built-in runner; tests live in `tests/` or next to the code as `*.test.ts`.

The tools are pure functions and testable without a model — a change to `read_file`,
`edit`, `grep` or `glob` should come with a test that doesn't need an API key. A bugfix
should come with a test that fails before it and passes after.

## Reporting bugs

Open an issue using the bug report form. Include `seri --version`, your OS and shell, and
the steps to reproduce.

For anything with security impact, **don't open an issue** — see
[SECURITY.md](./SECURITY.md).

## Licensing of contributions

By contributing, you agree that your contributions are licensed under the license in
[LICENSE](./LICENSE).

## Code of conduct

Participation is governed by the [Code of Conduct](./CODE_OF_CONDUCT.md).
