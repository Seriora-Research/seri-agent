---
name: engineering-loop
description: Run the shared explore→plan→execute→verify engineering loop in research, feature, or bugfix mode. Use when the user types /engineering-loop with a mode and a task prompt in Cursor.
argument-hint: "<research|feature|bugfix> \"<task prompt>\" [\"<role=model,...>\"]"
arguments: [mode, prompt, models]
disable-model-invocation: true
---

# Engineering Loop — mode: $0

You are the ORCHESTRATOR of a loop-engineered workflow. You sequence phases,
dispatch specialized subagents, enforce verification, and persist state.
You do NOT write production code yourself in feature/bugfix mode — you delegate.

Cursor runner: dispatch every named role through the Task tool
(`subagent_type` = the role name). Do not call a Claude Code `Agent` tool.
PLAN is not a Task type — read and follow the mode skill in this context
(see §3). Run state lives under `.cursor/loops/<slug>/` — never `.claude/loops/`.

## Task
$1

## 0. Initialize state (always)
1. Derive a short kebab `<slug>` from the task (e.g. "add-dark-mode").
2. Create `.cursor/loops/<slug>/` if missing. Write/append:
   - `STATE.md` filled from `.cursor/templates/state.md`
   - `trajectory.md` (append a timestamped INIT entry: mode, prompt, current branch)
   - `SESSION` — the Cursor session id, and nothing else. Copy
     `.cursor/session-id` (written by the `sessionStart` hook):
     ```bash
     sid=$(tr -d '[:space:]' < .cursor/session-id 2>/dev/null || true)
     printf '%s' "$sid" > .cursor/loops/<slug>/SESSION
     ```
     **Do not skip this.** It is how `log-trajectory`, `goal-audit-gate` and
     `verify-gate` tell this loop's files from every other loop's. Without it
     they fall back to "the only loop on disk", and the moment a second loop
     exists they stop logging and the Goal Audit gate blocks.
3. **Resolve model config** (override order — last wins):
   a. Built-in defaults: every role defaults to `inherit` — the runner's active
      model is used unless explicitly overridden.
   b. Read `.cursor/loop-models.json` if it exists and merge its values. Values
      must be Task model slugs this runner accepts, or `inherit`. No translation
      is done. Do not pass a Claude-Code-only model id to Task.
   c. Parse `$2` argument if provided (comma-separated `role=model` pairs,
      e.g. `"orchestrator=inherit,reviewer-verifier=inherit"`) and merge.
   d. `inherit` for any role means "use the runner's active model" — do not
      pass a model parameter when dispatching that subagent; let the runner decide.
      For any non-`inherit` resolved model, explicitly pass `model: <id>` in the
      Task call at dispatch time.
   e. Write the resolved table to STATE.md under `## Model config`.
4. Dispatch the `env-detector` subagent (Task `subagent_type: "env-detector"`,
   using its resolved model from step 3).
   It writes `.cursor/loops/<slug>/environment.md`.
   **All subsequent hook commands, subagent instructions, and tool invocations
   must adapt to what is recorded there** (e.g. use `pwsh` not `bash` on native
   Windows, use the detected package manager, respect WSL path conventions).
5. Read project `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*`, and note the mode
   skill to use later in PLAN (§3) — do NOT run it yet, GOAL AUDIT (§1) must
   run first:
   - research → `.cursor/skills/research-spec/SKILL.md`
   - feature  → `.cursor/skills/feature-plan/SKILL.md`
   - bugfix   → `.cursor/skills/bugfix-report/SKILL.md`

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
- A `preToolUse` gate hook (`.cursor/hooks/goal-audit-gate.*`) blocks writes of
  the mode plan files (`feature-plan.md` / `bugfix-report.md` / `research-spec.md`)
  under `.cursor/loops/` until this block exists with a non-empty `success_check`.
  No audit block → the loop cannot advance to planning.

## 2. EXPLORE (all modes)
Dispatch the `explorer` subagent (Task `subagent_type: "explorer"`, read-only).
For research on a new external technology, also dispatch `researcher`
(Task `subagent_type: "researcher"`). Return ONLY: relevant file paths,
entry points, dependencies, and a summary. Log results to `trajectory.md`.
Do not edit anything.

## 3. PLAN (all modes)
Read the mode skill from §0.5 and follow it in this orchestrator context
(Cursor has no Skill tool). Produce a structured plan/spec into
`.cursor/loops/<slug>/` using the mode template under `.cursor/templates/`.
Update STATE.md checklist.
Present the plan and STOP for human approval.

### 3b. PROMOTE the spec to `docs/specs/` (research and feature modes)
The loop directory is **scratch**: `STATE.md`, `trajectory.md` and
`environment.md` record *how the work was done* and are disposable. The spec
records *what was decided to be built* — that is project documentation and it
must not die in `.cursor/loops/`.

**Only after the human approves the plan** (§3's gate), copy it out:

| mode | from | to |
|---|---|---|
| research | `research-spec.md` | `docs/specs/<NNN>-<slug>/research.md` |
| feature | `feature-plan.md` | `docs/specs/<NNN>-<slug>/spec.md` |

For **feature** mode also write `docs/specs/<NNN>-<slug>/tasks.md` — the plan's
ordered step list as unchecked `- [ ]` boxes, one per step. EXECUTE (§4) checks
them off as it goes; it is the implementation's progress surface.

- `<NNN>` is the next free three-digit ID in `docs/specs/`. **Never reuse an ID
  and never renumber an existing one** — they are cited from outside this repo.
- If the task continues existing work (a successor loop, an `-impl` loop, a
  follow-up fix), promote **into that spec's existing directory** rather than
  allocating a new ID. One spec per unit of product, not one per loop run.
- **bugfix mode does not promote.** A fix report records a defect, not a
  decision about what to build. It stays in the loop directory.

**Cite specs by anchor, never by line number.** Write
`docs/specs/012-subagents/spec.md#verify-bar`, not `docs/BUILD-PLAN.md:357-391`.
Line numbers break on the first edit of the target — every existing
`docs/BUILD-PLAN.md:<n>` citation in `.cursor/loops/**` is already stale, which
is the evidence for this rule, not a hypothetical.

## 4. EXECUTE (feature, bugfix only — research stops after PLAN)
Read `.cursor/rules/pstack-loop.mdc` before dispatch. EXECUTE is pstack, not a
second copy of this orchestrator.

- **bugfix**: FIRST a FAILING regression test that reproduces the bug; confirm
  it fails; THEN fix; confirm it passes. If the Goal Audit raised T5, this is
  also where the stated root cause gets confirmed or overturned. Match pstack
  **Bug fix**.
- **feature**: match pstack **Feature**. Implement the approved plan, committing
  per step (`feat:`, `fix:`, `test:`, `refactor:`). After each step lands,
  check off its box in `docs/specs/<NNN>-<slug>/tasks.md` (§3b).
- Dispatch Task `subagent_type: "poteto-agent"` (isolation: own workspace,
  not shared). If `poteto-agent` is unavailable, dispatch `implementer` with
  the same plan and skip list. Cap at 3 parallel workers.
- Skip `opening-a-pr` / `shipping` / `babysit` / `orchestrate` /
  `autopilot-*`. VERIFY (this skill or Grok Bot) opens the PR later.

## 5. VERIFY (feature, bugfix; research uses a self-checklist)
1. Run the deterministic gates yourself (or via the `verify-gate` skill):
   lint, typecheck, full test suite. Record exit codes. The Stop/verify-gate
   hook is not wired — same as Claude Code after 2026-08-21.
2. Dispatch the `reviewer-verifier` subagent (Task
   `subagent_type: "reviewer-verifier"`, SEPARATE context, read-only + tests).
   Pass it `confirmed_goal` and `success_check` from the `## Goal Audit` block
   in STATE.md as the acceptance criterion it grades against, in addition to
   the plan and gate output. It reports CRITICAL / HIGH / MEDIUM / LOW. It
   must NOT edit code.
3. Write the verdict and gate results to STATE.md and `trajectory.md`.
4. Update this spec's row in `docs/ROADMAP.md` — state, and the PR number once
   one is open. **`docs/ROADMAP.md` is the single source of stage state**: do
   not restate a stage's status in `docs/ARCHITECTURE.md`, in a spec body, or
   in a second table anywhere. A stage whose state is recorded in two places
   is a stage whose state is wrong in one of them.

## 6. STOP CONDITION
If the `## Goal Audit` block's `success_check` is more specific than the
generic mode template below, use it in place of (or in addition to) the
matching clause:
- **research**: "A complete spec exists at `.cursor/loops/<slug>/research-spec.md`,
  every section of the template is filled, the self-checklist at the bottom is
  all checked, and — once the human has approved it — the spec is promoted to
  `docs/specs/<NNN>-<slug>/research.md` per §3b; or stop after 15 turns."
- **feature**: "Lint, typecheck, and the full test suite pass (shown via their
  exit codes in the transcript), git status is clean, every box in
  `docs/specs/<NNN>-<slug>/tasks.md` is checked, and the reviewer-verifier
  reported no CRITICAL or HIGH findings; or stop after 30 turns."
- **bugfix**: "The new regression test that previously failed now passes, the
  full suite is green, no other test file was modified, and lint+typecheck are
  clean; or stop after 20 turns."

## 7. OUTPUT & MEMORY
- Produce the mode-specific deliverable (spec / PR-ready summary / fix report).
- Append a final `trajectory.md` entry with commit SHAs and the goal outcome.
- `.cursor/hooks/*`, `.cursor/hooks.json`, `.cursor/agents/*`,
  `.cursor/skills/*`, and `.cursor/templates/*` are frozen by
  `protect-loop-core` while a loop is live. Do not write those paths from
  inside a run.
