---
paths: ["**"]
---

# Git workflow

## Feature branches + PRs, not direct pushes to main
Starting 2026-08-02 (user directive): new work lands via a feature branch and a pull
request, not a direct push to `main`. This applies to engineering-loop work too — when
an implementer subagent's work (in its own worktree/branch) is verified and ready to
land, push that branch to `origin` and open a PR (`gh pr create`) instead of the
orchestrator fast-forward-merging it into local `main` and pushing `main` directly.

**Why:** `main` already has a GitHub branch-protection rule requiring PRs
("Changes must be made through a pull request") — the direct push that landed Stage 3's
12 commits only succeeded because it silently bypassed that rule (owner-level bypass
permission). Confirmed with the user afterward this shouldn't be the normal path going
forward.

**How to apply:** For engineering-loop feature/bugfix work, EXECUTE still dispatches
implementer(s) in isolated worktrees as before, and VERIFY (gates, reviewer-verifier,
thermo-nuclear, live e2e where applicable) still happens before anything is proposed for
merge — none of that changes. What changes is the landing step: push the verified
branch to `origin` and open a PR against `main` rather than merging locally. Naming: a
descriptive branch name derived from the loop's slug (e.g. `hesper-stage-4-checkpoints`)
is reasonable; ask if unsure.

## PR review: `/code-review`, run by Claude, not a GitHub bot
Considered and explicitly rejected (user directive, 2026-08-02): the official Claude
GitHub App ("Code Review," auto-triggers on PR open, ~$15-25/review flat via usage
credits, needs a Team/Enterprise plan) and `claude-code-action` in GitHub Actions
(auto-triggers via workflow YAML, per-token billing, needs `ANTHROPIC_API_KEY` as a repo
secret). Neither is set up. Instead: after opening a PR, run the local `/code-review`
slash command against it yourself (the orchestrator, in-session) as part of the normal
verification flow — no bot, no new billing surface, no repo secret to manage. This is
in addition to, not instead of, the existing reviewer-verifier/thermo-nuclear passes
already run during a loop's VERIFY phase.

**Open, not yet resolved:** whether the orchestrator merges a PR itself once
gates + reviewer-verifier + thermo-nuclear + `/code-review` all pass, or always leaves
the actual GitHub merge for the human. Default until told otherwise: do NOT merge PRs
yourself — open them, verify them, then stop and hand off. Check this file for whether
that's been settled explicitly before assuming otherwise.
