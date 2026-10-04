---
name: issue-resolver
description: >
  Work a GitHub issue end to end: fetch, verify claims against the working
  tree, evaluate, optionally comment/clarify in the issue conversation (with
  consent gates), implement after approval, test, commit, push, open PR, link.
  Use for "analyze/fix/close issue #N", "work the opened issues",
  "answer in the issue thread".
compatibility: Requires git and gh (GitHub CLI) authenticated
metadata:
  author: danipl
---

# Issue Resolver

Standardized workflow for working an opened GitHub issue — analysis through
issue-thread conversation to PR. GitHub via `gh` CLI only.

## Core principle

Every outward or irreversible action sits behind an explicit approval gate.
Two channels the agent can speak in: **session** (always) and **issue
thread** (only after showing the user the exact draft text and getting
approval).

## State machine

```
P0 INTENT ──> classify: ANALYZE | TRIAGE | RESOLVE | CONVERSE
P1 FETCH   ──> gh issue view N --json body,labels,state,comments + timeline
P2 VERIFY  ──> every file:line / code claim checked against working tree
                dupes: branch name, gh pr list, timeline cross-refs
P3 EVALUATE──> verdict report (CONFIRMED / PARTIAL / WRONG + fix shape + effort)
   │
   ├─ [GATE 1: user] ──> mode choice
   ▼
P4 CONVERSE (optional, re-enterable)     P5 IMPLEMENT
   draft comment → user sees text           minimal change, repo invariants
   → approved → gh issue comment             + failure-path test REQUIRED
P6 VERIFY: repo gates (typecheck/test/build per AGENTS.md)
P7 DELIVER: git-master → commit/push/PR → "Fixes #N" in body
P8 LINK CHECK: gh api timeline → `connected` event confirmed
P9 REPORT + optional resolution note in thread (GATED)
```

## Mode routing (P0)

| User says              | Mode     | Reaches                          |
|------------------------|----------|----------------------------------|
| "analyze issue #N"     | ANALYZE  | P1–P3, stop                      |
| "which issues are worth doing" | TRIAGE | P1–P3 per issue, ranked table, no code |
| "fix #N" / "implement + PR" | RESOLVE | P1–P9                          |
| "ask/reply in the issue" | CONVERSE | P1–P4 (+ back to P0 after replies arrive) |

## Issue-thread conversation playbook (P4)

Four comment types, each drafted in session → approved → posted:

1. **Evaluation** — verdict of P2/P3 posted publicly: claims
   confirmed/corrected, severity, suggested fix shape. Use when the issue is
   stale or another party needs the verdict.
2. **Description match/refine** — compare issue body vs. reality; if drifted
   or thin, propose a revised `## Revised description`
   (acceptance-criteria-shaped). On approval: `gh issue edit N --body-file`
   (edit, not comment spam) or comment-only if author ≠ user.
3. **Clarifying question** — when P2 finds blocking ambiguity (wrong file,
   missing repro, 2x+ effort spread). Template: understood / unsure /
   options / recommendation.
4. **Conversation continue** — poll
   `gh issue view N --comments --json comments`; answer new replies citing
   `file:line` evidence; loop until consensus, then offer to re-run P0.

## Hard rules (gates)

- NEVER post/edit/close/comment on GitHub without showing the exact text
  first + explicit user approval. No auto `--yes`.
- NEVER implement from P3 unless the user asked — analyze ≠ implement.
- Branch first: if an issue-named branch/PR already exists, report it;
  don't duplicate.
- Verify-before-fix: unverified line references are fiction until read.
- Bugfix = minimal, root cause not symptom. New failure path without a test
  = incomplete.

## Delegation hooks

- Multi-claim verification → parallel `explore` /
  `cavecrew-investigator` (background)
- Delivered diff → `cavecrew-reviewer` before PR
- Tricky root cause → `oracle` consult before P5
- Commit/PR → `git-master` skill (repo convention)

## Scope boundaries

- GitHub via `gh` only (no web API hand-rolling); GitLab/other hosts →
  refuse, say so.
- Does not close issues manually — `Fixes #N` + merge does it.
- Not for PR-only reviews (`caveman-review` / `review-work`) or general
  research.
- Out-of-repo deliverables (host config, `~/.config` files): stop at P6,
  report the file path; no PR step applies, closing is manual by the author.
