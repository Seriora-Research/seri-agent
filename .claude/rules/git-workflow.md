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

**How to apply:** On Cursor, feature/bugfix work is pstack (`/poteto-mode`), including
Opening a PR — see `.cursor/rules/pstack-loop.mdc`. Gates still run. Default review is
`/interrogate` + `/no-comments`, plus `/blast-radius` before the PR. Push the branch
and open the PR; do not merge locally.

## PR review: `/code-review` stays the default; `@claude` in PRs is now also set up
Considered and explicitly rejected (user directive, 2026-08-02): the official Claude
GitHub App's managed "Code Review" product (auto-triggers on PR open, ~$15-25/review
flat via usage credits, needs a Team/Enterprise plan) — **this part of the rejection
still stands**, that product is not installed.

**Revised 2026-08-15:** `claude-code-action` in GitHub Actions was rejected at the same
time for "per-token billing, needs `ANTHROPIC_API_KEY` as a repo secret" — that specific
objection no longer applies. The action supports `claude_code_oauth_token` (generated via
`claude setup-token`) as an alternative to `anthropic_api_key`; runs then bill against the
user's Claude Pro/Max subscription instead of separate API usage. Set up in this repo:
`.github/workflows/claude.yml`, triggered by `@claude` in a PR/issue comment, secret
`CLAUDE_CODE_OAUTH_TOKEN`, GitHub App installed. This is a manually-triggered mention
workflow, not an auto-review-every-PR one.

Default in-session review on Cursor is pstack `/interrogate` (and `/no-comments` before
the PR). `/code-review` remains available as a user-triggered pass. The `@claude`
mention workflow is an ad hoc supplementary path.

**Open, not yet resolved:** whether the conductor merges a PR itself once gates +
review pass, or always leaves GitHub merge for the human. Default until told
otherwise: do NOT merge PRs yourself — open them, then stop and hand off.
