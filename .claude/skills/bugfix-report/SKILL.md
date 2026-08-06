---
name: bugfix-report
description: Reproduce a bug, write a failing regression test, fix it, and produce a structured bugfix report. Used by the engineering loop in bugfix mode.
argument-hint: "<bug description>"
allowed-tools: Read, Grep, Glob, Bash
model: inherit
---

Produce a bugfix plan for: $ARGUMENTS

Using `.claude/templates/bugfix-report.md`:
1. Document symptom and exact reproduction steps.
2. Identify the minimal failing test to add (file path + test name).
3. Diagnose root cause from code reading — do not guess.
4. Describe the minimal fix (what changes, what does not).
5. List verification steps: regression test passes, full suite green,
   lint + typecheck clean, no unrelated test files modified.

Write the result to `.claude/loops/<slug>/bugfix-report.md` and update
`STATE.md`. Do NOT implement the fix here — the implementer subagent does that
after this plan is approved.
