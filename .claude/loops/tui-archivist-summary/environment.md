# Environment — tui-archivist-summary
Detected: 2026-08-27T12:39:09Z

## OS & kernel
- Platform: Linux
- Version: Linux cursor 6.12.94+ #1 SMP PREEMPT_DYNAMIC Wed Aug 26 20:41:45 UTC 2026 x86_64 x86_64 x86_64 GNU/Linux
- WSL distro: N/A

## Shell
- Default shell: bash
- Shell version: GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu)
- Claude Code invoking via: bash

## Package managers (found only)
| tool | version |
|------|---------|
| npm  | 10.9.7 |
| pnpm | 10.33.3 |
| yarn | 1.22.22 |
| pip  | 24.0 (python 3.12; `pip` and `pip3` are the same binary) |
| cargo | 1.83.0 (5ffbef321 2024-10-29) |
| go   | go1.22.2 linux/amd64 |
| apt  | 2.8.3 (amd64) |

bun is **not present** on this VM (`which bun` empty; no binary under `/usr`, `/home`, `/opt`, `/exec-daemon`). Project commands below all invoke bun.

## Language runtimes (found only)
| runtime | version |
|---------|---------|
| node    | v22.14.0 (`/exec-daemon/node` on PATH; nvm also has v22.22.2 at `/home/ubuntu/.nvm/versions/node/v22.22.2`, which is where npm/pnpm/yarn live) |
| python3 | 3.12.3 |
| go      | go1.22.2 linux/amd64 |
| rustc   | 1.83.0 (90b35a623 2024-11-26) |
| java    | openjdk 21.0.10 2026-01-20 |

## Key tools
| tool   | version | present |
|--------|---------|---------|
| git    | git version 2.43.0 | yes |
| docker | — | no |
| curl   | curl 8.5.0 | yes |
| jq     | jq-1.7 | yes |
| make   | GNU Make 4.3 | yes |

## Path conventions
- Style: POSIX `/home/user/`
- Home: `/home/ubuntu`
- Project root: `/workspace`
- Line endings: LF

## Hook compatibility
- Shell invocation for hooks: `bash .claude/hooks/foo.sh`
- Notes: Native Linux (not WSL). Default `$SHELL` is `/bin/bash`. No PowerShell. bun missing — lint/typecheck/test as written in package.json will fail until bun is on PATH.

## Project commands (apps/cli — recorded, not run)
From `apps/cli/package.json`:
- lint: `tsc --noEmit` (alias of typecheck)
- typecheck: `tsc --noEmit`
- test: `SERI_DISABLE_MODELS_FETCH=1 bun test`

From repo-root `package.json`:
- lint: `bun run --cwd apps/cli lint`
- typecheck: `bun run --cwd apps/cli typecheck` (plus the other workspace typechecks)
- test: `bun run --cwd apps/cli test` (plus the other workspace tests)
