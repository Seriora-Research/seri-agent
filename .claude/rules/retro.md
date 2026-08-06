# Retro (self-improvement) rules

## Retro proposes, it never applies
The `retro` subagent has no Write/Edit tool. It reads trajectory.md, STATE.md,
and git history for the finished run and returns proposed lessons as TEXT in
its final message. Only the orchestrator (main context) may write a promoted
lesson into `CLAUDE.md` or `.claude/rules/*.md`, and only after the gate below.

## Promotion gate
- **Interactive runs**: present each proposed lesson and STOP for human
  approval before writing it anywhere — same discipline as the PLAN human gate.
- **Unattended `/goal` runs**: NEVER auto-promote. Append the proposal to
  `.claude/lessons/proposed/<slug>-<timestamp>.md` and mention it in the final
  trajectory.md entry. A human reviews and promotes later. This is deliberate:
  the loop may be running on a weak model, and a weak model's self-critique is
  not trustworthy enough to unsupervised-edit the instructions that govern
  every future run.

## Evidence or silence
Retro only proposes on an evidenced trigger (see `.claude/agents/retro.md`'s
trigger table) — a gate that failed repeatedly, a REQUEST-CHANGES category
that recurs from an existing lesson, a confirmed Tier 3+ Goal Audit objection,
or an unanticipated human correction. No trigger → retro returns `NO LESSON
THIS RUN` and nothing else. A proposal with no evidence is noise, and noise
trains the user to stop reading these.

## Frozen while a loop is active
`.claude/hooks/*`, `.claude/settings.json`, `.claude/agents/*`,
`.claude/skills/*`, and `.claude/templates/*` are frozen while a loop is live
— enforced by `protect-loop-core.sh`/`.ps1`, not by instruction. This is
deliberately a hard gate, not a soft one: these files define how the loop
grades and gates itself, so they must not be self-modifiable mid-run
regardless of which model is driving. Only `CLAUDE.md`, `.claude/rules/*.md`,
`.claude/lessons/**`, and ordinary project/loop files stay editable during a
run. To change hooks, agents, skills, or templates, do it in a plain session
with no active loop.

**What "live" means (corrected 2026-08-06):** a `STATE.md` directly inside
`.claude/loops/<slug>/` whose `Status` is neither `DONE` nor `BLOCKED`.
Archived runs under `.claude/loops/_archive/<slug>/` are excluded by depth, and
a finished-but-unarchived run is excluded by its Status. It previously froze on
*any* `STATE.md` at any depth, so one stale file from a run that had ended days
earlier froze these files indefinitely — which is how the freeze came to block
the repair of its own defects. Unreadable `Status` counts as live: this gate
fails closed.

**What it actually intercepts (corrected 2026-08-06):** the `Write` and `Edit`
tools, which is what its `PreToolUse` matcher is wired to. It does **not**
intercept the `Bash` tool — a `cp`, `tee`, `sed -i`, or heredoc redirect into a
frozen path passes straight through. This wording used to claim "ANY tool
call," which was false. The matcher was deliberately left narrow rather than
widened to `Bash`: catching every way a shell can write a file means
pattern-matching unbounded redirection syntax, which would still be bypassable
while *reading* as total. Treat the freeze as a reliable guardrail against
casual in-loop edits, not as a sandbox boundary against a determined one — and
do not route around it via Bash just because you can.

## Recurring-lesson dedupe
Before proposing, retro reads existing `CLAUDE.md` "Recurring lessons" and
`.claude/rules/*.md`. If the same failure recurs despite an existing lesson,
that is a stronger signal ("the lesson didn't stick") than a fresh duplicate
— retro must say so explicitly rather than writing a near-identical bullet
next to the one that already failed to prevent the mistake.
