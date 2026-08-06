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
`.claude/skills/*`, and `.claude/templates/*` cannot be edited by ANY tool
call while any `.claude/loops/*/STATE.md` exists — enforced by
`protect-loop-core.sh`/`.ps1`, not by instruction. This is deliberately a hard
gate, not a soft one: these files define how the loop grades and gates
itself, so they must not be self-modifiable mid-run regardless of which model
is driving. Only `CLAUDE.md`, `.claude/rules/*.md`, `.claude/lessons/**`, and
ordinary project/loop files stay editable during a run. To change hooks,
agents, skills, or templates, do it in a plain session with no active loop.

## Recurring-lesson dedupe
Before proposing, retro reads existing `CLAUDE.md` "Recurring lessons" and
`.claude/rules/*.md`. If the same failure recurs despite an existing lesson,
that is a stronger signal ("the lesson didn't stick") than a fresh duplicate
— retro must say so explicitly rather than writing a near-identical bullet
next to the one that already failed to prevent the mistake.
