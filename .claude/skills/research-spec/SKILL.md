---
name: research-spec
description: Explore a topic, library, or codebase; compare alternatives and tradeoffs; produce a structured markdown research spec / build contract. Used by the engineering loop in research mode.
argument-hint: "<task prompt>"
context: fork
allowed-tools: Read, Grep, Glob, WebSearch, WebFetch
model: inherit
---

Research the following thoroughly and produce a build-contract spec: $ARGUMENTS

1. If the task concerns an **existing codebase**: map directory structure (top 3
   levels), entry points, dependency graph, and the design patterns in use.
   Prefer LSP (goToDefinition / findReferences) over grep when available.
2. If the task concerns a **new technology**: gather authoritative sources
   (official docs first), and compare at least two alternatives with explicit
   tradeoffs (performance, maturity, ecosystem, lock-in).
3. Fill out `.claude/templates/research-spec.md` and write the result to
   `.claude/loops/<slug>/research-spec.md`: problem, constraints, options
   considered, recommendation + rationale, proposed architecture, file-level
   change plan, test strategy, acceptance criteria, risks, open questions,
   sources.
4. End with the self-checklist — every item must be checkable from the
   transcript so the /goal judge can verify completion without running tools.

Return the path to the written spec and a 5-bullet summary.
