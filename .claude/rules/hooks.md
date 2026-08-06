---
paths: [".claude/hooks/**", ".claude/settings.json"]
---

# Hook authoring rules

## verify-gate scope
verify-gate only fires when `.claude/loops/*/STATE.md` exists AND `Status` is `EXECUTE` or `VERIFY`
AND `Mode` is not `research`. It must exit 0 silently for all other sessions and phases.

## Iteration ceiling
verify-gate must not `exit 2` forever. After 5 consecutive failures it writes `Status: BLOCKED`
to STATE.md and exits 0. The counter is stored in `.claude/loops/<slug>/.gate-fail-count`.

## verify-gate assumes lint/typecheck/test scripts exist — it does not check first
verify-gate runs `<pkg> run lint`, `<pkg> run typecheck`, and `<pkg> test` unconditionally
whenever `package.json` exists, with no check that those scripts are actually defined.
Verified live (Stage 0 of a fresh scaffold, 2026-08-01): the approved plan defined `test`
and `typecheck` but not `lint`, so every Stop-hook firing during EXECUTE/VERIFY failed on
"script not found" — unrelated to actual code correctness — and after 5 consecutive
failures the hook auto-set `Status: BLOCKED`, a false signal. Any new JS/TS scaffold must
define all three scripts from the first commit, even as a no-op alias (e.g.
`"lint": "tsc --noEmit"` if no linter is configured yet), or this will recur on every
future stage built on that scaffold.

## block-dangerous.sh is a seatbelt, not a security boundary
It only intercepts Bash tool calls — Read, Write, and Edit bypass it entirely.
Label it accordingly; do not rely on it to prevent `.env` leaks from non-Bash tools.

## .env protection via Read tool
`.env` blocking for the Read tool is handled by `block-env-read.sh` / `block-env-read.ps1`,
wired as a separate `matcher: "Read"` PreToolUse hook in `settings.json`.
If you add new sensitive file patterns, update BOTH block-dangerous.sh AND block-env-read.sh.

## trajectory.md is an audit log
trajectory.md records what happened — it is not a replay artifact.
You cannot deterministically re-execute from it. Do not label it "replayable".

## Hook input arrives as JSON on stdin, never as env vars
Empirically verified (2026-07-20): Claude Code delivers PreToolUse/PostToolUse
payloads as a JSON object on **stdin** — `{"tool_name":"...","tool_input":{...}}`
— not as `CLAUDE_TOOL_INPUT_*` environment variables. `block-dangerous.sh`,
`block-env-read.sh`/`.ps1`, and `format-and-typecheck.sh`/`.ps1` all currently
read env vars that are never set, so their guard logic never actually runs
against real input. Any hook that inspects tool input MUST read and parse
stdin (see `goal-audit-gate.sh` / `protect-loop-core.sh` for the pattern —
no `jq` dependency, since it isn't guaranteed present; PowerShell variants
should use `[Console]::In.ReadToEnd() | ConvertFrom-Json`). Windows paths in
that JSON are double-backslash-escaped (`\\`) — collapse with
`sed -e 's/\\\\/\//g' -e 's/\\/\//g'` before pattern-matching; a plain
`tr '\\' '/'` doubles every slash instead of collapsing it.

## Never chain the bash/pwsh fallback with `||`
`bash script.sh || pwsh -File script.ps1` looks like "try bash, else pwsh,"
but `||` also fires whenever bash's script legitimately `exit 2`s to block
something — and if `pwsh` isn't on PATH (true on this dev machine, which only
has Windows PowerShell, not PowerShell Core), the fallback fails with
"command not found" (exit 127), silently swallowing the block. Verified live:
this exact pattern let a Skill dispatch through a hook that was correctly
exiting 2. Use `if command -v bash >/dev/null 2>&1; then bash script.sh; else
pwsh -NonInteractive -File script.ps1; fi` instead — it picks one
implementation based on availability, never masks a real exit code.
`goal-audit-gate` and `protect-loop-core` use this form; the pre-existing
hooks (`block-dangerous`, `block-env-read`, `format-and-typecheck`,
`verify-gate`) still use the broken `||` form and should be migrated the same
way before they're trusted.

## goal-audit-gate scope
goal-audit-gate is a PreToolUse hook matched on the `Skill` tool. It only inspects
dispatches of the mode planner skills (`feature-plan`, `bugfix-report`, `research-spec`)
— every other skill invocation, including `challenge-the-goal` itself, passes through
untouched. It blocks (exit 2) unless the active STATE.md has a `## Goal Audit` block
with a non-empty `success_check` line. This is what makes the orchestrator's Goal
Audit step (§1 of the engineering-loop skill) a real gate instead of a step the model
can silently skip.

## protect-loop-core scope
protect-loop-core is a PreToolUse hook matched on `Write|Edit`. It only fires
while a loop is active (any `.claude/loops/*/STATE.md` exists), and only blocks
writes whose path contains `.claude/hooks/`, `.claude/settings.json`,
`.claude/agents/`, `.claude/skills/`, or `.claude/templates/`. Everything else
— `CLAUDE.md`, `.claude/rules/*.md`, `.claude/lessons/**`, loop artifacts, and
ordinary project source — passes through untouched, including during EXECUTE.
See `.claude/rules/retro.md` for why this exists: it is the hard-gate half of the
self-improvement design, so a RETRO proposal (or any other in-loop edit) can
never rewrite the enforcement layer that is supposed to be grading it.
