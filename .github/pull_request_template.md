<!--
  The body below becomes the PR description. Delete sections that don't apply.
  Comments like this one are invisible in the rendered PR.
-->

## What and why

<!-- What changes, and what problem it solves. Link the issue: Fixes #123 -->

## How

<!-- The approach, and anything a reviewer would otherwise have to reverse-engineer
     from the diff. If you considered another approach and rejected it, say why. -->

## Verification

<!-- CI runs typecheck + test + build on Linux, macOS and Windows. Tick what you
     actually ran locally — not what you assume passes. -->

- [ ] `bun run typecheck`
- [ ] `bun test`
- [ ] `bun run build`, and ran the resulting binary
- [ ] Exercised the change by hand (say how, below)

<!-- How you exercised it: -->

## Cross-platform impact

<!-- seri ships on Linux, macOS and Windows from one codebase, and most of its
     regressions have been platform-specific. -->

- [ ] Touches file paths, file I/O, process spawning, signals, or shell invocation
- [ ] If ticked: verified on both a POSIX shell and PowerShell

## Notes for the reviewer

<!-- Known gaps, follow-ups, anything deliberately left out of scope. -->
