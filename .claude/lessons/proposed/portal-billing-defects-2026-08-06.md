# Proposed lessons — `portal-billing-defects`, 2026-08-06

Produced by the `retro` subagent at the end of the `portal-billing-defects` loop.
**Presented at the interactive gate and deferred by the user — promote none of these without a
fresh decision.** Nothing here has been written into `CLAUDE.md` or `.claude/rules/*`.

Run: base `main` @ `457548ca`, branch `portal-billing-defects`, 10 signed commits, PR #31.
reviewer-verifier APPROVE (4 MEDIUM); thermo-nuclear REQUEST CHANGES (1 HIGH, 4 MEDIUM, zero
findings against the code).

---

## 1. A quantity the plan states as measured must carry its derivation

**Target:** new section in `.claude/rules/engineering-loop.md`, immediately after "Self-approved
PLAN: cross-check prose incremental-behavior claims…", so the two read together.

**Evidence.** `bugfix-report.md` asserted "every ordinary `/billing` render for a paid customer
would go from one Polar call to two". The page goes from **four to five**; one-to-two was
`liveSubscription`'s own count presented as the page's. `trajectory.md` records the user
approving exactly that sentence as the accepted tradeoff at the human gate. The implementer
copied it verbatim into `page.tsx`, thirty lines below the comment that sizes the org-wide 429
budget for that page. It survived until the thermo-nuclear pass, where it was the run's only
HIGH. Fixed in `d1e559d2` and corrected in the plan itself.

**Dedupe.** Two near-relatives, neither a duplicate. `.claude/rules/code-quality.md`'s "a comment
that documents an intention rather than a behaviour is worse than none" fires at the code comment
and its remedy is to re-read comments near changed code — but this comment was *new* and faithful
to its source; the source was wrong. `.claude/rules/engineering-loop.md`'s self-approved-PLAN rule
is the closest sibling and is explicitly scoped to a waived human gate. This run had a real gate
and the claim shipped anyway. **That scope limit is the thing to escalate.**

**Proposed text.**

> ## A quantity the plan states as measured must carry its derivation — the human gate cannot check it
> Any number a plan asserts about runtime behaviour (call counts, request budgets, line counts,
> latency) is enumerated from real call sites at PLAN time and the enumeration goes in the plan,
> because implementers copy plan prose verbatim into code comments and a human approving "the
> plan, verbatim" approves the number with it. Verified live (`portal-billing-defects`,
> 2026-08-06): the plan said the page goes "from one Polar call to two"; it goes from four to
> five — one-to-two was `liveSubscription`'s own count presented as the page's. The user accepted
> that sentence as the tradeoff at the gate, the implementer copied it into `page.tsx` thirty
> lines below the comment that sizes the org-wide 429 budget, and it shipped until thermo-nuclear
> caught it as its only HIGH. Same check as the self-approved-PLAN rule above, minus the
> self-approval precondition.

---

## 2. Build the RED-verification matrix from the diff, not from the plan's fix list

**Target:** new section in `.claude/rules/engineering-loop.md`, adjacent to "STATE.md is updated
at every phase boundary…".

**Evidence.** The orchestrator's mutation matrix had three rows because the plan had three fixes.
The fourth changed behavioural line — the Cancel guard moved from `scheduled` to
`effectiveScheduled`, an implementer deviation already reviewed and accepted in prose — had no row
and no test: mutating it back left all 143 portal tests green. reviewer-verifier found it for
free, using a strictly better method the orchestrator had not used: restore **all** changed
production files to base at once and run the branch's tests (139 pass / 4 fail, exactly one case
per defect). Gap closed in `b5aa5d29`.

**Dedupe.** Duplicate in *principle* of `.claude/rules/code-quality.md`'s "an acceptance check
must be seen to fail before it counts as passing". That principle was honoured — the enumeration
it was applied to was wrong. Escalate with the mechanical form rather than restating the principle
beside itself.

**Proposed text.**

> ## Build the RED-verification matrix from the diff, not from the plan's fix list
> Enumerate rows from `git diff <base>..HEAD`, not from the plan's numbered fixes: an accepted
> implementer deviation is a changed behavioural line with no row, and reviewing it in prose is
> not testing it. Cheapest strict form, and the one to use by default: restore **all** changed
> production files to base at once and run the branch's tests — one run yields the expected
> one-failure-per-defect count and exposes any changed line no test covers. Verified live
> (`portal-billing-defects`, 2026-08-06): three planned fixes were mutated and all went red; the
> fourth changed line — the Cancel guard, a deviation already reviewed and accepted — had no test
> at all, and mutating it back left all 143 portal tests green. reviewer-verifier found it for
> free with the restore-everything form.

---

## 3. Worktree isolation bounds a plan's outputs too, not only its inputs

**Target:** append to the **existing** section "An isolated implementer can only do git in its own
worktree" in `.claude/rules/engineering-loop.md`, after the `abort-cancellation` corollary. Not a
new bullet — retro flagged this as the "the lesson didn't stick" case, which
`.claude/rules/retro.md` calls a stronger signal than a fresh duplicate.

**Evidence.** The plan listed `docs-tmp/polar-e2e.md` in the blast radius without checking that
`docs-tmp/` is `.gitignore:14`. The isolated implementer could not edit it, correctly refused to
fabricate an uncommittable stub, and returned the exact markdown instead; the orchestrator applied
it in the shared checkout. Branch blast radius is 8 files, not the 9 the plan implied — so the
countable acceptance clause the reviewer later graded was itself wrong.

**Dedupe.** Same root cause as the existing section, whose remedy paragraph covers "inputs that
exist only as untracked files in the shared checkout". This run failed on the mirror case: an
ignored **deliverable**. The lesson was present and did not prevent it.

**Proposed text.**

> **Second corollary, from `portal-billing-defects` (2026-08-06):** the isolation bounds the plan's
> *outputs* as well as its inputs. Check every file in a plan's blast radius against `.gitignore`
> before the gate — an ignored path (`docs-tmp/`, `.claude/`) can never be committed from a
> worktree, so the step is unexecutable there and the blast-radius clause the reviewer later
> grades is wrong by that file. Verified live: the plan listed `docs-tmp/polar-e2e.md` for defect
> 4, `docs-tmp/` is `.gitignore:14`, the implementer correctly refused to fabricate an
> uncommittable stub and returned the text, and the orchestrator applied it in the shared checkout
> — branch blast radius 8 files, not the plan's 9.

---

## Judged and NOT proposed

- **The thermo-nuclear rubric refusing to load.** Real, but no trigger row covers it and the run
  disclosed it voluntarily, so there is no evidenced cost this time. Retro's reasoning is worth
  keeping: it declined to propose prose *because* prose is what would fail here — a rule saying
  "declare which rubric ran" is skippable by the same context that would skip noticing.
- **The user's mid-run question about gitignored design docs.** A question is not a correction,
  and the artifacts show the orchestrator reaching the right answer on its own. Covered by
  proposal 3 if that is promoted.

---

## Two fixes that prose cannot deliver — require a plain session with no active loop

`.claude/hooks/*`, `.claude/settings.json`, `.claude/agents/*`, `.claude/skills/*` and
`.claude/templates/*` are hard-frozen by `protect-loop-core` while any `.claude/loops/*/STATE.md`
exists. Both of these live there:

1. **The thermo-nuclear pass can silently run without its rubric.**
   `.claude/rules/engineering-loop.md` makes the pass unconditional, but
   `cursor-team-kit:thermo-nuclear-code-quality-review` is marked `disable-model-invocation` and
   refuses to load. A future loop can truthfully write "thermo-nuclear: pass" having run only a
   fallback audit. This run disclosed it; a weaker model may not. Fix at the skill/settings layer.
2. **The mutation matrix should be generated, not transcribed.** Proposal 2's prose helps, but the
   durable version is VERIFY deriving its rows from `git diff --name-only <base>..HEAD` so an
   unplanned changed file cannot be absent from the table. That is a `SKILL.md` change.
