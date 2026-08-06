---
paths: [".claude/skills/engineering-loop/**", ".claude/skills/**", ".claude/loop-models.json"]
---

# Engineering-loop authoring rules

## Argument substitution
Always use positional `$0`/`$1`/`$2` in skill bodies — never named vars like `$mode` or `$prompt`.
Named `arguments:` frontmatter is for autocomplete hint only; named interpolation is undocumented and unreliable.

## Human gate
The PLAN phase always stops for human approval — no "trivially one-liner" exception.
Self-judged skip conditions are where scope creep enters unattended runs.

## Model config key for the reviewer
The key in `loop-models.json` is `reviewer-verifier` (matches the agent filename).
Never use `reviewer` — it does not bind to any agent and the override is silently dropped.

## Loop state location
All run state lives under `.claude/loops/<slug>/` — never `.engineering-loop/` or any project-root directory.

## research mode
research mode stops after PLAN and never enters EXECUTE or VERIFY.
The Stop hook guards on this; the SKILL must not tell the orchestrator to proceed past PLAN in research mode.

## research-spec skill
Do not add `agent: Explore` to research-spec SKILL.md.
`context: fork` + correct `allowed-tools` is sufficient; `agent: Explore` mis-routes web research.

## CI failure diagnosis
When a CI failure's annotation is generic (e.g. "Process completed with exit code 1")
or its reported line number doesn't correspond to a real source line, do not fix based
on circumstantial matches (a coincidental line-number match, "most recently changed
file" reasoning). Verified live (Stage 1 of a build, 2026-08-01): two fix commits were
written and pushed based on exactly this kind of guess, and both were wrong — the real
failure (confirmed only once actual job logs were fetched) was in a completely
different, untouched file. Exhaust real job-log retrieval first: the unauthenticated
public API 403s on log download ("Must have admin rights to Repository"), but the git
credential already used for pushing can be reused, read-only, directly as a Bearer
token against `api.github.com/repos/<owner>/<repo>/actions/jobs/<job_id>/logs` (follow
the redirect with `-L` to the signed blob URL) — never print the token itself, only use
it inline in the request. A first 403 on the normal path is a credential-approach
problem to solve, not a signal to fall back to guessing.

## Self-approved PLAN: cross-check prose incremental-behavior claims against the plan's own type contracts
When the PLAN human-gate is waived (self-approval), explicitly verify that every prose
claim about incremental/streaming behavior in the plan ("after each X", "on every Y")
is actually realizable given the type signatures the same plan defines for that
component (event unions, generator yield/return types, callback signatures). If the
type doesn't expose the state the prose claim needs, fix the contract in the plan
before EXECUTE, not after. Verified live (Stage 2 of a build, 2026-08-01): a
self-approved plan defined a closed `LoopEvent` union with no message-snapshot event,
two lines after requiring the CLI to "save the session after each turn" — a
contradiction present in the plan document itself, undetected until a post-implementation
review forced a structural rework (the loop/cli boundary couldn't actually deliver
"a killed session resumes with context intact," the stage's own literal acceptance bar).
A human PLAN reviewer would plausibly have asked about this gap before EXECUTE; the
self-approval path skipped that check.

## Goal audit placement
The `challenge-the-goal` skill runs in the orchestrator's main context, as step 1,
before EXPLORE — never inside a subagent. A subagent's challenge can't reach the
user, and a Tier 4 block needs authority to halt the whole loop; only the main
context has that. Invoke it by name, not by relying on description-based
auto-triggering — the loop is unattended-capable and undertriggering silently
defeats the point.

## Thermo-nuclear-code-quality-review always follows reviewer-verifier in VERIFY
Standing rule, not a per-STATE.md amendment to re-declare each loop (user directive,
2026-08-02): every VERIFY phase (feature and bugfix modes) dispatches the
`thermo-nuclear-code-quality-review` skill immediately after `reviewer-verifier`
returns its verdict, unconditionally — not gated on the reviewer-verifier finding
anything. Cap at 2 passes per loop, matching the precedent set across
vela-stage-0/1/2 and hesper-rename. SKILL.md §5 (VERIFY) must invoke it as an explicit
step, not rely on the orchestrator manually copying a "process amendment" note into
each new loop's STATE.md — that manual-carry-forward pattern already silently dropped
once (hesper-stage-3-compaction's STATE.md omitted it, despite every prior loop in
this project having it, and vela-stage-2-loop's own retro had already predicted this
exact failure mode: "depends on the orchestrator remembering to copy it forward...
worth the user formalizing"). If you are editing SKILL.md and a loop is currently
active (`.claude/loops/*/STATE.md` exists), you cannot make this edit yet —
`.claude/skills/*` is hard-frozen while any loop is active; make this change in a
plain session with no active loop instead.

## Rename/rebrand loops: the naming vocabulary is elicited, never derived
For any rename or rebrand, the Goal Audit must produce a **user-confirmed table mapping
each context to its name** — binary/command, package name and npm scope, env-var prefix,
repo slug, display wordmark, and product-name-in-prose — before `feature-plan` is
dispatched. These are the owner's call, not a planner judgment.

Verified twice, in the only two rename loops this project has run:
- `hesper-rename` (2026-08-01) derived the product name "Hesper Code" unilaterally and
  its STATE.md explicitly recorded "flagging this assumption plainly rather than
  re-asking, since it's a low-risk, easily-corrected choice."
- `seriora-rebrand` (2026-08-04) drafted `seri-agent` as the product's name in prose.
  The user corrected it mid-gate ("cuando se refiere al agente, es seri"), forcing a
  plan revision across seven sections plus a new acceptance criterion.

The failure mode is specific: **a name that reads as one string ("the product is called
X") routinely means three or more different strings in three different contexts.** In
`seriora-rebrand` the final vocabulary was `seri` (the agent, in all prose and the
binary), `seri-agent` (identifier only — repo slug and subdomain, never prose), and
`Seriora Research` (the lab, one app only). No amount of planner reasoning recovers that
split; it has to be asked.

Ask before PLAN, not at the human gate — a correction at the gate rewrites the plan,
and a correction after EXECUTE rewrites the diff.

## Facts EXPLORE marks "not recorded in the repo" are questions, not risks
When EXPLORE reports that something about how the project ships or runs is not
discoverable from the repo (deploy target and trigger, hosting, release cadence, DNS,
domain ownership), ask the user before `feature-plan` is dispatched — do not write the
unknown into the plan's risk table as an inference. Verified live
(`install-url-rewrites`, 2026-08-04): EXPLORE found "How apps/web is deployed is NOT
recorded in the repo"; the plan turned that into the risk "deploy is manual /
configured outside the repo and might never run"; the user corrected it at the gate —
apps/web deploys automatically on every merge to main. Same shape as the rename rule
above: an owner-only fact, cheap to ask, not derivable from the tree.

## An isolated implementer can only do git in its own worktree
Dispatch instructions must keep every git operation inside the agent's own worktree —
the isolation hook refuses any git command targeting a worktree that is not the agent's
own ("Refusing to run it — a worktree-isolated agent's git operations must target its
own worktree"): the shared checkout, **another agent's worktree**, and `git -C` alike,
so "work in the main working directory" is unexecutable, not merely discouraged.
When an increment needs inputs that exist only as untracked files in the shared
checkout, either commit them on the branch first, or instruct a plain filesystem copy
into the worktree (not a git operation, and allowed). Verified live
(`install-url-rewrites` part 2, 2026-08-04): the orchestrator dispatched the branding
implementer to the main working directory because the two source images were untracked
and would not propagate into a fresh worktree; every git call was refused and the agent
had to re-plan mid-run.

**Corollary for resumes, from `abort-cancellation` (2026-08-05):** when a cut-off agent
left uncommitted work in its worktree, do NOT pin the new implementer to that worktree —
that is another agent's, and the refusal covers it. Dispatch into its own, branched from
the current tip, hand it the dirty diff as a plain patch file, and fast-forward
afterwards. Verified live: pinning cost a dispatch of re-planning, and the pattern above
is what the rest of that loop actually used.

## A plan decision is closed by a production call site, not by a report that it needed no code
When an implementer says a numbered plan decision required no work from it, check before
relaying that to the human: grep the symbol the decision names for callers outside
`tests/`. A new parameter with zero production call sites is an unimplemented decision
that every gate passes, because its tests call it directly. Verified live
(`abort-cancellation`, 2026-08-05): decision D5 ("for `bash`/`powershell` as well as
rg") was reported as already satisfied because "the rejection lives in `spawnCollect`";
`spawnCollect`'s `signal` parameter had no production caller, and the measured effect was
a regression — `bash.execute` with an already-aborted signal ran 4072 ms and returned a
*successful* ProcessResult, so one Ctrl-C stopped killing the tree and the second press
produced the exact error the loop existed to remove. Gates were green throughout; only
reviewer-verifier caught it.

## STATE.md is updated at every phase boundary, and the gate table is filled before VERIFY dispatches
Treating `STATE.md` as a PLAN-phase artifact and abandoning it at EXECUTE defeats the reason the
reviewer and retro run in separate contexts. Verified live (`stage-4-checkpoints`, 2026-08-04):
the file was frozen at `Status: EXECUTE` with an empty Gate results table and
`Reviewer verdict: <pending VERIFY>` while the whole of EXECUTE and VERIFY happened — so the
retro could not verify a single VERIFY-phase claim from the repository and had only the
orchestrator's prose about its own performance, which is the one thing that role exists not to
take on trust.

Concretely: write the phase transition when it happens, and fill the Gate results table **before**
dispatching `reviewer-verifier`, not after it reports. If the approved plan states a countable
acceptance clause — a line budget, a net-deletion target, a blast-radius file list — it is a row
in that table with a measured value, pass or fail. A failed clause is a stop-and-simplify, not an
orchestrator judgment call to be defended to the reviewer afterwards.

**Corollary:** when the implemented cost overshoots the plan's own estimate by more than roughly
2x, treat the gap as evidence the design is wrong rather than as an overrun to absorb. Same loop:
a gated system-rg mode was priced at "two spawns, ~10 lines" and landed at 57; thermo-nuclear
later found its distinguishing half had never rejected anything in the entire test suite, and the
whole thing was deleted.