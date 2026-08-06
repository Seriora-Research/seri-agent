---
name: engineering-loop
description: Run the shared explore→plan→execute→verify engineering loop in research, feature, or bugfix mode. Use when the user types /engineering-loop with a mode and a task prompt.
argument-hint: "<research|feature|bugfix> \"<task prompt>\" [\"<role=model,...>\"]"
arguments: [mode, prompt, models]
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Bash, Write, Edit, Task, WebSearch, WebFetch
model: inherit
---

# Engineering Loop — mode: $0

You are the ORCHESTRATOR of a loop-engineered workflow. You sequence phases,
dispatch specialized subagents, enforce verification, and persist state.
You do NOT write production code yourself in feature/bugfix mode — you delegate.

## Task
$1

## 0. Initialize state (always)
1. Derive a short kebab `<slug>` from the task (e.g. "add-dark-mode").
2. Create `.claude/loops/<slug>/` if missing. Write/append:
   - `STATE.md` filled from `.claude/templates/state.md`
   - `trajectory.md` (append a timestamped INIT entry: mode, prompt, current branch)
3. **Resolve model config** (override order — last wins):
   a. Built-in defaults: every role defaults to `inherit` — the runner's active
      model is used unless explicitly overridden.
   b. Read `.claude/loop-models.json` if it exists and merge its values. Values
      are any model ID string the host runner accepts (e.g. `kimi-2.6`, `gpt-4o`,
      `gemini-2.5-pro`, `o3`, `claude-sonnet-4-6`). No translation is done.
   c. Parse `$2` argument if provided (comma-separated `role=model` pairs,
      e.g. `"orchestrator=kimi-2.6,reviewer-verifier=o3"`) and merge.
   d. `inherit` for any role means "use the runner's active model" — do not
      pass a model parameter when dispatching that subagent; let the runner decide.
      For any non-`inherit` resolved model, explicitly pass `model: <id>` in the
      Agent tool call at dispatch time.
   e. Write the resolved table to STATE.md under `## Model config`.
4. Dispatch the `env-detector` subagent (using its resolved model from step 3).
   It writes `.claude/loops/<slug>/environment.md`.
   **All subsequent hook commands, subagent instructions, and tool invocations
   must adapt to what is recorded there** (e.g. use `pwsh` not `bash` on native
   Windows, use the detected package manager, respect WSL path conventions).
5. Read project `CLAUDE.md`, `.claude/rules/*`, and note the mode skill to use
   later in PLAN (§3) — do NOT dispatch it yet, GOAL AUDIT (§1) must run first:
   - research → `/research-spec`
   - feature  → `/feature-plan`
   - bugfix   → `/bugfix-report`

## 1. GOAL AUDIT (all modes, before EXPLORE)
Before dispatching the explorer subagent, invoke the `challenge-the-goal` skill
**by name** (named invocation, not description matching) and run its Phase 0
audit against the task in `$1`. This runs in the main (orchestrator) context —
never inside a subagent — because a subagent's challenge can't reach the user
and a Tier 4 block needs authority to halt the whole loop.

- **Interactive runs**: Tier 2–4 challenges surface to the user normally, per
  the skill's response tiers. Wait for a reply before continuing to EXPLORE.
- **Unattended `/goal` runs** (turn-capped): downgrade per tier —
  - Tier 1 → append the note to `trajectory.md`, proceed.
  - Tier 2–3 → state the assumption explicitly, take the most reversible
    interpretation, log the dissent as one `DECISION:` line in `trajectory.md`
    (per the skill's disagree-and-commit rule — do not re-raise it later
    without new evidence), proceed.
  - Tier 4 → hard abort. Set `Status: BLOCKED` in STATE.md with the block
    reason, append to `trajectory.md`, and end the run without dispatching
    EXPLORE.
- **Mode-specific tuning**:
  - research: only T1/T2 realistically fire; the audit is usually a fast
    pass-through.
  - feature: full trigger table applies.
  - bugfix: T5 (wrong premise) is the one to watch — the user's stated root
    cause is a claim, not a fact yet. Fold its resolution into the existing
    reproduce-before-fix step in EXECUTE: confirm the stated cause via the
    failing regression test before implementing the stated fix.
- Regardless of outcome (including "no trigger fired"), write a `## Goal Audit`
  block to STATE.md before moving on:
  ```
  ## Goal Audit
  - triggers_fired: [T2] | none
  - tier: 0-4
  - resolution: <assumption made, or "none — goal was unambiguous">
  - confirmed_goal: <restated, concrete goal>
  - success_check: <a command or condition that can be mechanically verified>
  ```
  `success_check` is mandatory even when no trigger fired — restate the task's
  own acceptance criterion concretely. It becomes the canonical input to the
  STOP CONDITION (§6) and to the reviewer-verifier in VERIFY (§5).
- A `PreToolUse` gate hook (`.claude/hooks/goal-audit-gate.*`) blocks dispatch
  of the mode skill (`feature-plan` / `bugfix-report` / `research-spec`) in
  PLAN (§3) until this block exists with a non-empty `success_check`. No audit
  block → the loop cannot advance to planning.

## 2. EXPLORE (all modes)
Dispatch the `explorer` subagent (read-only). For research on a new external
technology, also dispatch `researcher` (web). Return ONLY: relevant file paths,
entry points, dependencies, and a summary. Log results to `trajectory.md`.
Do not edit anything.

## 3. PLAN (all modes)
Dispatch `planner` (the `/feature-plan` or `/research-spec` or `/bugfix-report`
skill). Produce a structured plan/spec into `.claude/loops/<slug>/` using
the mode template. Update STATE.md checklist.
Present the plan and STOP for human approval.

## 4. EXECUTE (feature, bugfix only — research stops after PLAN)
- **bugfix**: FIRST have the implementer write a FAILING regression test that
  reproduces the bug; confirm it fails; THEN fix; confirm it passes. If the
  Goal Audit raised T5, this is also where the stated root cause gets confirmed
  or overturned before the stated fix is implemented.
- **feature**: dispatch `implementer` subagent(s) (isolation: worktree) to
  implement the approved plan, committing per step with conventional-commit
  messages (feat:, fix:, test:, refactor:).
- For independent workstreams, dispatch up to 3 implementer subagents in
  parallel. Cap at 3 — each worktree is a near-full working-file copy.

## 5. VERIFY (feature, bugfix; research uses a self-checklist)
1. Deterministic gates run automatically via hooks (lint, typecheck, tests).
   Exit code 2 from the Stop hook forces Claude to keep working.
2. Dispatch the `reviewer-verifier` subagent (SEPARATE context, read-only +
   tests). Pass it `confirmed_goal` and `success_check` from the `## Goal
   Audit` block in STATE.md as the acceptance criterion it grades against, in
   addition to the plan and gate output. It reports
   CRITICAL / HIGH / MEDIUM / LOW. It must NOT edit code.
3. Write the verdict and gate results to STATE.md and `trajectory.md`.

## 6. STOP CONDITION
Set a `/goal` condition (a separate judge model reads the transcript to decide).
If the `## Goal Audit` block's `success_check` is more specific than the
generic mode template below, use it in place of (or in addition to) the
matching clause:
- **research**: "A complete spec exists at `.claude/loops/<slug>/research-spec.md`,
  every section of the template is filled, and the self-checklist at the bottom
  is all checked; or stop after 15 turns."
- **feature**: "Lint, typecheck, and the full test suite pass (shown via their
  exit codes in the transcript), git status is clean, and the reviewer-verifier
  reported no CRITICAL or HIGH findings; or stop after 30 turns."
- **bugfix**: "The new regression test that previously failed now passes, the
  full suite is green, no other test file was modified, and lint+typecheck are
  clean; or stop after 20 turns."

## 7. OUTPUT & MEMORY
- Produce the mode-specific deliverable (spec / PR-ready summary / fix report).
- Append a final `trajectory.md` entry with commit SHAs and the goal outcome.

## 8. RETRO (self-improvement, all modes, best-effort)
Dispatch the `retro` subagent — a FRESH context, never the orchestrator's own
— to review this run's `trajectory.md`, `STATE.md`, and git history for
evidenced, recurring mistakes worth fixing in the loop itself (not the code).
This mirrors why VERIFY (§5) uses a separate reviewer-verifier instead of
letting the implementer grade itself: a model reflecting on its own run in
its own context has the same blind spots that produced the run.

- retro has no Write/Edit tool. It returns proposed lessons as text, or
  exactly `NO LESSON THIS RUN` if no trigger fired — see
  `.claude/agents/retro.md` for the evidence-gated trigger table. Do not treat
  silence as a failure; a clean run producing no lesson is the common case.
- **Promotion gate** (see `.claude/rules/retro.md`):
  - Interactive runs: present each proposed lesson and STOP for human approval
    before writing anything to `CLAUDE.md` or `.claude/rules/*.md`.
  - Unattended `/goal` runs: NEVER auto-promote. Write the proposal to
    `.claude/lessons/proposed/<slug>-<timestamp>.md` and note it in the final
    `trajectory.md` entry for a human to review later. This holds regardless
    of how capable the model driving this run is — self-improvement that
    writes to its own governing files without a human or separate-context
    gate is exactly the failure mode this design avoids.
- `.claude/hooks/*`, `.claude/settings.json`, `.claude/agents/*`,
  `.claude/skills/*`, and `.claude/templates/*` are enforced-frozen by the
  `protect-loop-core` hook for the entire duration of any active loop — not
  just during RETRO. Neither retro nor the orchestrator can write to them
  from inside a run, promoted or not. This is a hard gate, not an instruction.
