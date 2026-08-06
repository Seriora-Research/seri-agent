---
paths: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.py", "**/*.go", "**/*.rs", "**/*.java", ".claude/agents/implementer.md", ".claude/agents/reviewer-verifier.md"]
---

# Code-quality rules (Karpathy guidelines)

These apply whenever writing, editing, or reviewing code.

## Think before coding
- State assumptions explicitly before implementing. If uncertain, ask — don't guess silently.
- If multiple interpretations exist, present them; do not pick one without surfacing the choice.
- If a simpler approach exists, say so and push back.

## Simplicity first
- Write the minimum code that solves the problem. No speculative features, abstractions, or
  configurability that wasn't asked for.
- No error handling for scenarios that cannot happen.
- If the result is 200 lines and could be 50, rewrite it.
- Gut check: "Would a senior engineer call this overcomplicated?" If yes, simplify.

## Surgical changes
- Touch only what the task requires. Do not improve adjacent code, comments, or formatting.
- Match existing style, even if you would do it differently.
- If you notice unrelated dead code, mention it — do not delete it.
- Remove only the imports / variables / functions that YOUR changes made unused.
- Every changed line should trace directly to the user's request.

## Goal-driven execution
Transform every task into a verifiable goal before touching code:
- "Add validation"  → write tests for invalid inputs, then make them pass.
- "Fix the bug"     → write a test that reproduces it, then make it pass.
- "Refactor X"      → confirm tests pass before and after.

For multi-step tasks, state the plan first:
```
1. [step] → verify: [check]
2. [step] → verify: [check]
```
Weak success criteria ("make it work") require constant clarification and let bugs hide.

**An acceptance check must be seen to fail before it counts as passing.** This applies to a
manual end-to-end run exactly as much as to a unit test — record the negative control next to
the green result: the mutation that turns it red, the setup that was skipped, the refusal that
made it vacuous. A check whose subject was never touched reports success identically to one that
worked. Verified live three times in one loop (`stage-4-checkpoints`, 2026-08-04): a manual
`/undo` e2e printed `BYTE-IDENTICAL: True` comparing an untouched file to itself, because the
permission gate defaulted to read-only and the model declined to write — twice, on two different
runs; and 921 lines of implementer tests passed while `/undo` moved the worktree *forward* onto a
state the user had reverted, because every assertion checked file **content** and the wrong state's
content matched. The loop's own plan already carried this rule for one test and it was honoured
there and nowhere else.

## Carry forward known test guards when re-testing an already-tested primitive
Before writing a new test that exercises a function/primitive already covered by an
existing test elsewhere in the codebase (e.g. an adapter wrapping a previously-tested
spawn/platform call), open that existing test file first and carry forward any platform
guard (`describe.skipIf`) or timeout margin it already needed for the identical symptom
— don't re-derive from scratch and let CI rediscover the same fix a second time.
Verified live (Stage 2 of a build, 2026-08-01): two separate real CI failures, on two
different commits, both traced to a new adapter test for `runPowerShell` that omitted
the `win32`-only skip guard and the 15000ms timeout margin Stage 1's own
`tools/powershell.test.ts` already needed for the exact same cold-start symptom.

## Cross-platform env-var-dependent code needs real-CI verification, not local-only pass
When code or tests depend on environment/platform state that can differ between the
implementer's own machine and CI (env vars like `HOME`/`LOCALAPPDATA`, path separators,
homedir resolution), a local test pass is not sufficient evidence — the implementer's own
dev machine may already have that variable set, masking the bug entirely. Verified live
(Stage 0, 2026-08-01): the same class of bug broke CI twice in a row — once because
reassigning a `HOME` override at runtime doesn't redirect Bun's `os.homedir()` on POSIX,
and again because test teardown that "restores" an env var by reassigning a captured
`undefined` value actually sets it to the literal string `"undefined"` (Node/Bun coerce
`process.env.X = undefined` to that string), polluting later tests in the same process.
Neither was reproducible locally because the dev machine already had `HOME` set. Fix
pattern: test teardown must `delete` the env var when the original was unset, never
reassign `undefined` directly. Treat the mechanically-verified CI result (all target
OSes) as the actual source of truth for this class of bug, not a local re-run.

**Two corrections to that last sentence, both learned the hard way:**
- It settles which result is *final*. It is **not** a licence to leave the dev box's own
  capability unprobed. Verified live (`signal-child-cleanup`, 2026-08-03): this paragraph was
  cited as the reason not to install bun in WSL; the user overruled it in one line, and WSL then
  **reproduced a bug that had never been observed by anyone** — after which both mutation checks
  ran locally, before a single commit was pushed.
- **The platform matrix does not cover the *unset* case.** Green gates on N operating systems are
  not evidence for a path guarded by an env var, because every dev box and every CI runner has
  `HOME`/`LOCALAPPDATA` set. When a change makes a formerly-unconditional path newly depend on one
  (`getConfigDir()`, a config dir that can be read-only), the required test deletes the variable or
  makes the directory unwritable and asserts the fallback.

## A comment that documents an intention rather than a behaviour is worse than none
This repo's long why-comments carrying real measurements are its main asset, and that is exactly
what makes a false one expensive: a reviewer reads the guarantee, believes it, and stops checking.
Verified live (`stage-4-checkpoints`, 2026-08-04): three of six findings in a single review round
were comments asserting properties the code did not have — `shadowGit.ts` said the project's
`.gitignore` was honoured when a subdirectory launch put it out of scope entirely; `AGENTS.md`
said two histories "cannot drift apart" while retention deleted refs and kept their logs;
`readLog`'s comment framed malformed input as "skipped rather than fatal" when it was fatal.
When you change code that a nearby comment describes, re-read the comment and make it true or
delete it — and say in your report which comments you corrected, not only which code.
