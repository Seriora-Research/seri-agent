# Proposed lessons — `run-decomp-spend-bound`, 2026-08-06

**Status: PROPOSED, NOT PROMOTED.** Owner reviewed all three on 2026-08-06 and chose to promote
none for now. Nothing was written to `CLAUDE.md` or `.claude/rules/*.md`. Kept here for a later
decision, per `.claude/rules/retro.md`'s promotion gate.

Produced by the `retro` subagent in a fresh context. Two of the four candidates it was handed
were **rejected on the evidence** — those rejections are recorded at the bottom because they are
as useful as the proposals.

---

## 1. "Print the commit beside every measured result" — the rule the project believes it has

**This is not a duplicate. The rule does not exist.** `grep -rn -iE "print the commit|commit next
to|wrong-commit"` over `CLAUDE.md`, `AGENTS.md` and all of `.claude/rules/` returns **zero**
matches. The habit lived in `NOTES.md` §2 — an untracked file, present at session start, **no
longer on disk**. The one practice that caught three bad greens in this run is recorded nowhere
a future loop will read.

Aggravating: `STATE.md` asserted *"`.claude/rules/code-quality.md`'s 'print the commit next to
the result' still applies"* — written by the orchestrator, and false. Same class as the defect
the run kept finding in the code.

Three wrong-commit incidents in one session:
- `env-detector` read `origin/main` and reported it as the checkout state; its entire baseline
  (279/13/0) was measured on a different branch and had to be voided.
- The reviewer-verifier's WSL invocation **printed `457548ca` while running `1c1abc56`**:
  `$(git rev-parse …)` inside `wsl.exe -- bash -ic '…'` expands **Windows-side**.
- The orchestrator ran repo-wide gates that silently executed in the wrong directory after a
  failed `cd`, because the commands were newline-separated rather than `&&`-chained. Caught only
  by the printed commit line. *(The retro rejected this one as a lesson — see below — because it
  was absent from the run's own record. It is kept here as context for the other two.)*

Same class produced wrong-commit greens on PR #27 and PR #30.

**Proposed home: `.claude/rules/git-workflow.md`**, and the reasoning matters — it is the only
rules file with `paths: ["**"]`, so it is the only one loaded unconditionally. `code-quality.md`
is scoped to source globs and `engineering-loop.md` to `.claude/skills/**`; neither is reliably
in context for an orchestrator running gates in a shell, which is exactly when the rule is
needed. Putting it in `code-quality.md` would recreate "the rule exists but is not loaded at the
moment of the mistake."

> ## Print the commit beside every measured result
> Any gate number, baseline, or acceptance-check green is reported with the commit it was
> measured at, printed by the same command that produced it. Two mechanical traps, both hit in
> one session (`run-decomp-spend-bound`, 2026-08-06): reading `origin/main` and reporting it as
> the checkout state (the env-detector did this; its whole baseline was void), and
> `$(git rev-parse …)` inside `wsl.exe -- bash -ic '…'`, which expands **Windows-side** — the
> label and the tested tree disagreed silently. Use a literal `git log --oneline -1` inside the
> quoted string, never a `$(…)` substitution. Same class produced wrong-commit greens on PR #27
> and PR #30.

---

## 2. "Seen to fail" against a test double proves only what the double does not supply

Refinement of the existing paragraph at `.claude/rules/code-quality.md:41-51` — **one clause
appended, not a second rule.**

Evidence: reviewer-verifier's blocking HIGH-1. The test `"still prints the summary for a run
that ended in an error"` (`cli.test.ts` at `1c1abc56`) drives
`fakeRunLoop([usageEvent(120, 30), { type: "error", … }])` — it injects the usage event whose
*absence on the error path* was the actual defect (`loop.ts:210-218`, fixed in `72ec128a`). The
negative control proved `cli.ts`'s summing worked and said nothing about the producer.

The retro judged prose plausible here, unlike lesson 3: the rule was honoured well everywhere it
was understood this run (negative controls recorded with real output; the step-1 implementer
moved a vacuous assertion; the reviewer strengthened binary check 5 and refused to inherit check
6's green). This was a coverage hole, not a rule being skimmed.

> A check driven by a test double is only seen to fail for what the double does not supply. If
> the double hand-feeds the very value under assertion, the negative control proves the printer
> works and says nothing about the producer — assert against the real producer, or state in the
> report which half is unpinned.

---

## 3. The false-comment rule is being cited by name and still failing

**Duplicate of `.claude/rules/code-quality.md:91-100` — the "didn't stick" signal in its
strongest available form**, which `retro.md` says must be stated as such rather than written as
a near-identical bullet beside the rule that already failed.

The loop **read the rule and cited it by filename before writing any code**
(`trajectory.md:64-67`). It then recurred four separate times: step 2 corrected three, the
reviewer-verifier found two more, thermo-nuclear found three more (`3af60eab`).

The decisive datum: **the commit written to fix the reviewer's false-comment finding introduced
a fresh false comment of the same class.** `264ed896` added `// All nine LoopEvent members are
handled above…` against a ten-member union; `3af60eab` corrected it 15 minutes later. Same file,
same session, same category.

> Comments that state a **count**, a **never/always**, or a **named flag or scenario** are the
> ones that go stale silently — check each such claim in your own diff against the code or a
> test in the same pass, before committing.

**The retro's own caveat, which is the important part: prose is unlikely to fix this one.** The
prose already existed and was quoted by name before the mistake recurred three more times. What
actually caught all three was thermo-nuclear running after reviewer-verifier. A real fix is a
checklist item on the reviewer-verifier or implementer surface ("list the factual claims in the
comments your diff added or moved, with the line that makes each true") — `.claude/agents/*` is
frozen while a loop is active, so the retro flagged the shape and deliberately did not draft it.

---

## Rejected by the retro, with reasons

- **The failed `cd` / newline-separated gate.** Rejected as **unverifiable**: it appears in
  neither `STATE.md` nor `trajectory.md`. The retro refused to propose a rule from an anecdote
  it could not confirm. **Why it was unverifiable is the real finding:** `trajectory.md` was
  abandoned at PLAN (last modified 10:50) while the run produced 11 commits through 12:42 and
  `STATE.md` was maintained to 12:57. EXECUTE and the whole of VERIFY — the reviewer verdict,
  thermo-nuclear, the fix commits, three wrong-commit incidents — have no trajectory entry.
  `engineering-loop/SKILL.md:124` and `.claude/rules/engineering-loop.md:154-167` already carry
  this instruction and this lesson; it half-stuck, because `STATE.md` was kept excellently and
  `trajectory.md` was not. The retro judged this **hook-shaped** — a phase-transition check that
  refuses to advance while `trajectory.md`'s last entry predates the current phase — and did not
  draft prose, since hooks are a frozen surface.
- **The vacuous plan-authored acceptance check.** Rejected because **the system worked**: the
  step-1 implementer caught the orchestrator's own plan defect, and the reviewer independently
  caught the same class twice more. Three independent catches in one run is evidence
  `code-quality.md:41-51` is load-bearing and needs no change.
- **Loop gate scope vs CI scope.** Rejected on the trigger table — no gate failed, no category
  recurred, no user correction; the loop caught it itself before proposing merge and re-ran all
  four gates repo-wide, clean. Flagged only: `AGENTS.md:39-40` covers the OS axis and says
  nothing about the scope axis, so a clause there would be the natural home if it ever recurs.
