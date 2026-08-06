---
name: verify-gate
description: Run the deterministic verification gate (lint, typecheck, tests) and summarize pass/fail. Use after implementation and before declaring done.
allowed-tools: Read, Bash
model: inherit
---

## Context
Changed files: !`git status --short`
Shell to use: read `.claude/loops/<slug>/environment.md` → "Claude Code invoking via" field.

## Steps
1. Read `environment.md` to find the correct shell and the detected package manager.
2. Run lint, typecheck, and the full test suite using the commands from `CLAUDE.md`
   (or the detected stack if CLAUDE.md has none).
3. Report a compact table:

   | gate       | command          | exit code | failures |
   |------------|------------------|-----------|----------|
   | lint       | …                | 0 / 1     | n        |
   | typecheck  | …                | 0 / 1     | n        |
   | tests      | …                | 0 / 1     | n        |

4. If anything failed, list the first failing item per gate with `file:line` and
   a one-line cause.
5. Do NOT fix anything — only report. The orchestrator decides next steps.
