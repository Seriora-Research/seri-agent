# Loop State — <slug>
- Mode: <research | feature | bugfix>
- Task: <prompt>
- Branch: <branch>
- Status: <INIT | EXPLORE | PLAN | EXECUTE | VERIFY | DONE | BLOCKED>
- Started: <iso8601>  |  Updated: <iso8601>

## Model config
| role             | model   |
|------------------|---------|
| orchestrator     | inherit |
| env-detector     | inherit |
| explorer         | inherit |
| researcher       | inherit |
| planner          | inherit |
| implementer      | inherit |
| reviewer-verifier | inherit |
| test-runner      | inherit |
| retro            | inherit |

## Goal Audit
- triggers_fired: <[T1,T2,...] | none>
- tier: <0-4>
- resolution: <assumption made, or "none — goal was unambiguous">
- confirmed_goal: <restated, concrete goal>
- success_check: <a command or condition that can be mechanically verified>

## Plan checklist
- [ ] step 1 …

## Gate results (latest)
| gate      | command | exit | notes |
|-----------|---------|------|-------|
| lint      |         |      |       |
| typecheck |         |      |       |
| tests     |         |      |       |

## Reviewer verdict
<APPROVE | REQUEST-CHANGES + reasons>

## Retro
- status: <NOT_RUN | NO_LESSON | PROPOSED>
- proposal: <path under .claude/lessons/proposed/, or "n/a">

## Open questions / blockers
-
