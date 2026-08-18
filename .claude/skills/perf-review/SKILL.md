---
name: perf-review
description: Audit the repo (or a given path, branch, or diff) for performance problems — algorithmic bottlenecks, memory leaks, unnecessary allocation/recomputation, blocking I/O, N+1 access patterns — and report prioritized, evidence-backed findings without changing any code. Use when the user asks to find performance issues, memory leaks, or bottlenecks, or wants to optimize how the app runs or how much memory it uses.
argument-hint: "[path|branch|PR#|diff] [low|medium|high|max]"
allowed-tools: Read, Grep, Glob, Bash
model: inherit
---

Every finding in this review must trace back to one goal: **make the app run faster or
use less memory without changing observable behavior.** A finding that isn't about
runtime cost, or whose fix would change behavior, error handling, or output, does not
belong here — that's a correctness review, not this one.

## Parse the target

Arguments: `$ARGUMENTS`

- No target given → whole repo, default effort `medium`.
- A path/directory → scope to that path.
- `diff`, a branch name, or a PR number → scope to `git diff` against the repo's
  default branch (`!`git status --short`` and `!`git diff --stat` <base>...HEAD`` for
  context).
- A trailing `low|medium|high|max` token sets effort (default `medium`) — it controls
  how much you report, not what counts as a real finding:
  - **low/medium**: only high-confidence findings on paths you've confirmed are hot
    (see below). Prefer fewer, certain findings over a long list.
  - **high/max**: broader file coverage and lower-confidence-but-plausible findings
    are allowed, clearly marked as such.

Exclude generated/vendored code, build output, lockfiles, and binary assets from the
scan regardless of scope — grep the manifest/build config to identify these rather than
guessing from extension alone.

## Find what's actually hot

Don't review files uniformly — prioritize code that runs often or on large inputs:
entry points and request/event/tool-call handlers, anything inside a loop that scales
with user data, code that runs per-frame/per-tick/per-request/per-message, startup
paths (only worth flagging if the delay is user-visible), and anything doing I/O,
network calls, subprocess spawning, serialization, or hashing inside a loop.

For each candidate, confirm the finding is real before reporting it: read the call
site(s), how often the path actually executes, and the realistic size of the data it
handles. An O(n²) loop over an input capped at 5 elements is not a finding — say so to
yourself and move on rather than padding the report.

## Categories to check

- **Algorithmic complexity** — nested loops over the same collection, a linear
  scan (`find`/`indexOf`/`includes`/`filter`) repeated inside an outer loop where a
  map/set/index would do, repeated recomputation of a value that doesn't change
  across iterations or calls.
- **Memory leaks / unbounded growth** — listeners, subscriptions, or callbacks
  registered without a matching removal; caches, maps, or arrays that only grow with
  no eviction, TTL, or size bound; timers/intervals never cleared; closures that hold
  a reference to something large well past when it's needed; handles/streams/sockets/
  file descriptors/child processes not released on every exit path, including error
  and early-return paths.
- **Blocking work on a hot/shared path** — synchronous I/O, crypto, or heavy
  compute where an async or off-thread alternative exists and the call site can't
  tolerate blocking (an event loop, a UI thread, a request handler serving concurrent
  callers).
- **Redundant I/O** — N+1 query/request patterns, re-reading or re-parsing the same
  file/response on every call instead of once, sequential `await`s over independent
  work that could run concurrently, missing memoization for a pure and expensive
  function that's called repeatedly with the same inputs.
- **Unnecessary allocation/copying** — deep-cloning or spreading large structures
  inside a loop or hot path, string concatenation in a loop instead of a builder/join,
  recreating a stable object/function/regex on every call instead of hoisting it.
- **Wasted work** — computing or fetching more than the caller needs (a full record
  to read one field, eager work that could be lazy), work repeated across nearby calls
  that could be batched or shared.
- **Rendering (only if the repo has a UI layer)** — unmemoized expensive renders,
  unstable props/keys forcing full-list re-renders, interleaved layout reads/writes
  causing thrashing.

## Rank and report

Order findings by expected impact: how hot the path is (per-request/frame beats
startup-only beats rare/admin-only) times the gap between current and achievable cost.
A correct-but-marginal finding on a cold path ranks below a smaller win on a hot one.

For every finding, the suggested fix must preserve behavior. If a plausible fix would
also change edge-case handling, error semantics, or output (e.g. trading correctness
for speed, dropping a validation step, changing float precision), say so explicitly as
part of the finding instead of presenting it as a free win — the user decides whether
that tradeoff is acceptable, this review doesn't decide it for them.

Report using the `ReportFindings` tool, most-severe/highest-impact first:
- `summary` — the mechanism: why this is slow or leaks, not just what the code does.
- `failure_scenario` — the concrete condition that makes it manifest (input size,
  call frequency, time-since-start for a leak) — not "could theoretically be slow."
- `category` — one of `algorithmic-complexity`, `memory-leak`, `blocking-io`,
  `redundant-io`, `unnecessary-allocation`, `wasted-work`, `rendering`.

Do not edit, run, or benchmark anything — this skill only reads code and reports. If
the user wants a finding fixed, that's a separate step after they've seen the report.
