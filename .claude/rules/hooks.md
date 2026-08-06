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

**This lesson did not stick — recorded 2026-08-06.** `log-trajectory.sh`/`.ps1`
had the identical defect (`$CLAUDE_SUBAGENT_NAME`, `$CLAUDE_SUBAGENT_STATUS`,
neither of which exists, and it never read stdin) and was simply not on the list
above, which is why 671 of its 674 rows said `unknown-agent`/`unknown`. It is
fixed now; the real fields are `agent_type` and `agent_id`. Per
`.claude/rules/retro.md`'s dedupe rule the recurrence is the finding, not a
duplicate bullet: **when adding a lesson that names specific files, the list is
the weak part** — the next hook written won't be on it. Assume any hook not
explicitly verified has this bug.

**Still unfixed as of 2026-08-06:** `block-dangerous.sh`, `block-env-read.sh`
and `format-and-typecheck.sh` continue to read env vars and never read stdin, so
their guard logic still never runs against real input. Both `block-*` hooks are
therefore currently no-ops, not seatbelts. Out of scope of the 2026-08-06 hook
repair, which covered only the four loop-aware hooks; fix them before relying on
either one.

## A loop-aware hook must resolve WHICH loop from `session_id`, never `find … | head -1`
Every loop-aware hook used to pick its target with
`find .claude/loops -name STATE.md | head -1`. Nothing in that identifies the
*active* loop: `find` returns every loop's file and `head -1` takes whatever
`readdir` yields first. Verified 2026-08-06 with 14 loop dirs on disk, it was
consistently a run that had finished two days earlier. Measured on that run's
trajectory: 674 entries, 671 of them written by the hook into the wrong loop.

The damage is worst where it is least visible. `goal-audit-gate` exists to block
planning when a loop skipped its Goal Audit; reproduced with the *active* loop's
`success_check` deliberately empty — exactly what it is built to catch — the old
gate exited 0 and let the planner dispatch, because it graded a finished run's
paperwork. **A gate reading the wrong file reports green identically to one that
works.**

The fix, and the pattern for any new loop-aware hook:

1. The loop writes `$CLAUDE_CODE_SESSION_ID` to `.claude/loops/<slug>/SESSION`
   at INIT (engineering-loop SKILL.md §0.2). Verified 2026-08-06 that this env
   var is identical to the `session_id` the hook receives on stdin, which is a
   common field on **every** hook event including `PreToolUse`, `Stop` and
   `SubagentStop`.
2. The hook parses `session_id` from its own stdin payload and selects the loop
   whose `SESSION` matches.

Two concurrent loops are two sessions, so this scales; a single global
`.claude/loops/ACTIVE` pointer would not — the two loops would overwrite it.

Keep a fallback for loops predating `SESSION`, but only when the answer is
unambiguous: exactly one `STATE.md` at `-maxdepth 2` (which also stops archived
loops under `.claude/loops/_archive/` from counting). When it is ambiguous, each
hook fails in **its own** safe direction — `goal-audit-gate` blocks,
`log-trajectory` writes nothing, `verify-gate` exits 0 rather than forcing
continuation against another run's state. "Safe" is per-hook, not global.

## `.claude/hooks/*.ps1` must be ASCII-only
Windows PowerShell 5.1 decodes a `.ps1` with no BOM as cp1252, so any non-ASCII
character inside a **string literal** breaks the script — an em dash (`—`,
UTF-8 `e2 80 94`) ends up as `â€"`, and that trailing `0x94` is a curly right
quote, which PowerShell accepts as a string terminator. Verified 2026-08-06 by
execution: a no-BOM file containing `"alpha — beta"` dies with "The string is
missing the terminator", the BOM'd twin prints fine.

Committed `goal-audit-gate.ps1` had three such lines, so it could never have run
on this machine. It went unnoticed because of the `||` bug above: `pwsh` isn't
installed here, so the PowerShell half of every hook had never executed at all.
Fixing the `||` chains is what would have made these live.

Prefer ASCII over adding a BOM — a BOM is invisible and easily dropped by an
editor, whereas ASCII-only survives any tool. Check with
`grep -Pn '[^\x00-\x7F]' .claude/hooks/*.ps1`, which must return nothing.

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

**Migrated 2026-08-06: every hook in `settings.json` now uses the safe form**
(`format-and-typecheck`, `verify-gate`, `log-trajectory`, `block-dangerous`,
`block-env-read` were the five still on `||`; note this rule previously listed
only four and missed `log-trajectory`). `grep -c '||' .claude/settings.json`
returns 0 and must stay 0.

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
while a loop is live (a `.claude/loops/<slug>/STATE.md` whose `Status` is
neither `DONE` nor `BLOCKED` — see `.claude/rules/retro.md`), and only blocks
writes whose path contains `.claude/hooks/`, `.claude/settings.json`,
`.claude/agents/`, `.claude/skills/`, or `.claude/templates/`. Everything else
— `CLAUDE.md`, `.claude/rules/*.md`, `.claude/lessons/**`, loop artifacts, and
ordinary project source — passes through untouched, including during EXECUTE.
See `.claude/rules/retro.md` for why this exists: it is the hard-gate half of the
self-improvement design, so a RETRO proposal (or any other in-loop edit) can
never rewrite the enforcement layer that is supposed to be grading it.
