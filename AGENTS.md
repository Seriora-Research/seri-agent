# AGENTS.md

Guidance for AI agents working in this repository.

## What this is

This repository is the seri CLI harness. It ships as the `seri` binary, written in
TypeScript on Bun. Work here is `apps/cli` and the packages that binary needs
(`packages/daemon-client`, `packages/model-catalog`, `packages/plans`).

Hosted apps, billing, and research docs live in `lzvxck/seri-agent`. Do not add them here.

## Commands

- `bun run dev -- <args>` — run the CLI from source
- `bun test` — run the test suite (bun's built-in runner)
- `bun test path/to/file.test.ts` — run a single test file
- `bun run typecheck` (alias `lint`) — `tsc --noEmit`
- `bun run build` — compile to `dist/seri` for the current platform
- CI (`.github/workflows/ci.yml`) runs typecheck + test + build on Linux, macOS, and
  Windows on every push — treat all three as required, not just the local OS

## Invariants

- The loop is a library: `apps/cli/src/loop/loop.ts`. It never writes stdout.
- Write tools are gated via `WRITE_TOOL_NAMES` in `apps/cli/src/provider/tools.ts`.
- `bash` / `powershell` never get an "always" grant.
- `memory_write` is the deliberate exception; it is not in that list.
- Conductor is pstack (`/poteto-mode`). Do not run a second orchestrator. Do not merge.
- Do not hand-edit `apps/cli/src/tools/rg-vendored.bin`.

Open the file that owns a behavior instead of restating it here. Cancellation lives in
`apps/cli/src/signals.ts`. The gate lives in `apps/cli/src/gate/gate.ts`.

## Review

Prioritize the loop, tools, permissions, and cancellation. Prefer the smallest change
that matches existing tests. Feature work lands via a branch and a PR.
