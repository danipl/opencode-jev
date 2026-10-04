---
name: grilling
description: >
  Rigorous investigate → implement → gate → ship workflow for agentic coding,
  with hard human validation gates before any push, PR, or merge. Covers intent
  classification, verifying claims against authoritative sources, checking
  documented repo rules for conflicts, minimal (ladder-ranked) implementation,
  evidence-based verification with behavior simulation, Conventional Commits
  with release-automation awareness, and CI watching. Use when the user says
  "grill this", "grilling", wants the standard branch-commit-PR loop, asks for
  an implementation taken through a pre-push approval gate, or says
  "investigate and implement" / "standard workflow".
compatibility: Requires git and gh (GitHub CLI) authenticated
metadata:
  author: danipl
---

# Grilling

A standardized, rigorous loop for taking an implementation request from vague
intent to merged PR without breaking anything on the way. Every outward or
irreversible action (push, PR, comment, merge, release) sits behind an explicit
human approval gate. Silence is never approval.

## Stage 0 — Intent gate

Classify the request out loud before touching anything:

- **research / question / evaluation** → answer only. Never edit.
- **implementation** → proceed, but only when the request is explicit.
- **fix** → diagnose first; minimal root-cause change.
- **open-ended** ("improve", "refactor") → assess the codebase before following patterns.
- **ambiguous** (2×+ effort spread across interpretations, or missing critical
  info) → ask ONE clarifying question, then stop.

Grill the request itself:

1. Does it need to exist at all? (YAGNI — say so in one line if not.)
2. What breaks if we do it vs. not do it?
3. Which repo rules constrain it? Read `AGENTS.md`, `CONTRIBUTING`, CI config
   **before** planning. These files own the invariants; ignore them and the PR
   gets rejected.

## Stage 1 — Investigate against authoritative sources

Never rely on model memory for tool, library, or config semantics. Verify
against the actual source of truth:

- The config JSON/YAML schema the tool validates against.
- Upstream source files for exact constants, regexes, defaults.
- `git log` for repo commit-message and scope conventions.
- Read every file the change touches; trace the flow end to end before editing.

Fire parallel explore/search agents when scope spans multiple areas.

Output a one-line verdict per claim: `CONFIRMED <source>` — or the claim dies.

## Stage 2 — Conflict check

Before editing, list every documented repo rule that forbids or blocks the
change (e.g. "Never edit `release-please-config.json`").

Conflict found → surface it, propose the explicit resolution, and fold the
doc/rule amendment into the **same branch**. The resolution must keep
protecting what the rule guarded: machine-owned outputs stay locked; only
genuinely human-owned inputs are freed. Never silently violate a documented
rule.

## Stage 3 — Branch + plan

```bash
git status --short --branch      # clean tree? right base?
git checkout -b <type>/<short-name>   # e.g. feat/readme-version-stamping
```

If a branch or PR for the task already exists, reuse it — do not duplicate.

Create a todo list for 2+ step tasks. Exactly one item `in_progress`; mark
complete immediately, never batch.

## Stage 4 — Minimal implementation

The ladder — stop at the first rung that holds:

1. Needed at all? (speculative → skip, one line of reasoning)
2. Already in this codebase? → reuse it.
3. Stdlib does it? → use it.
4. Native platform feature covers it? → take it.
5. Already-installed dependency solves it? → use it. Never add one for what a
   few lines can do.
6. One line possible? → one line.
7. Only then: the minimum code that works.

Rules: no unrequested abstractions, no scaffolding "for later", deletion over
addition, fix root causes not symptoms. User-facing docs affected by the
change are updated in the same branch — docs are part of the feature.

## Stage 5 — Verify with evidence

The task is NOT complete without proof, cheapest first:

1. `git diff` reviewed hunk-by-hunk; confirm scope matches the request.
2. **Behavior simulation**: when logic depends on a third-party engine,
   replicate its exact algorithm locally (`node -e` / `python -c` with the
   real regexes/constants copied from fetched source) and show expected
   output. No waiting on production.
3. Repo gates mandated by AGENTS.md/CI — run every one and record counts.
4. Pre-existing failures are reported, never silently fixed.

## Stage 6 — Conventional commit

Where release automation reads commit messages (e.g. release-please:
`feat:` → minor, `fix:` → patch, `!`/`BREAKING CHANGE:` → major; `chore:` /
`docs:` → no release), the type choice is load-bearing. Match `git log` scope
convention. Grill the choice: does this deserve a version bump? Offer the
`feat:` vs `chore:` trade-off when it matters.

```bash
git add <intended files only>        # never blind git add -A
git commit -m '<type>: <imperative summary ≤72 chars>' \
           -m '- <what/why bullets>'
```

No "this commit…", no AI attribution, no trailing period, imperative mood.

## Stage 7 — HARD GATE: human validation

STOP. Present and wait for an explicit yes:

- Table: file → one-line change summary.
- Evidence: simulation results, gate outputs, test counts.
- Consequences of the commit type (e.g. "merging opens the 1.1.0 release PR").
- The exact next commands to be run.

Silence is not approval. Never push, PR, merge, or comment outwardly on
silence.

## Stage 8 — Push + PR (only after approval)

```bash
git push -u origin <branch>

gh pr create \
  --title '<same Conventional subject as the commit>' \
  --body '## What
- <bullets: file, change, why>

## Why
<one paragraph: problem solved>

## Verification
- <simulations, gate outputs, test counts>

## Notes
<side effects: release automation, follow-up PRs the merge opens>'
```

Gotchas: squash-only repos lint the **PR title** as the commit message (make it
lint-safe); `gh auth status` must pass first; PR merge is the human's decision
unless told otherwise. Use `Fixes #N` in the body when closing an issue so the
link is automatic.

## Stage 9 — Watch CI, then report

```bash
gh pr checks <n>               # poll after ~45s
gh run list --branch <branch> --limit 5
gh run view --log-failed       # on failure
```

Green → report and stop. Red → fix on the branch, push, re-watch. After 2
failed fix attempts → escalate to a stronger reasoning agent with full
context; never shotgun. After merge, summarize the downstream automation chain
(release PR, publish) and ask before touching any of it.

## Failure recovery

3 consecutive failures → stop editing, revert to the last known good state,
document what was attempted and what failed, escalate with full context.

Never: leave the tree broken, delete tests to pass, `--no-verify`, force-push
over someone else's work, or bypass branch protection.

## Final checklist

- [ ] Intent classified out loud; non-implementation requests answered only
- [ ] Every claim verified against an authoritative source, with citations
- [ ] Documented rule conflicts surfaced and resolved in the same branch
- [ ] Clean branch from the right base (no duplicated branch/PR)
- [ ] Minimal diff per the ladder; docs updated with the feature
- [ ] Diff reviewed hunk-by-hunk
- [ ] Behavior simulation + repo gates pass, output recorded
- [ ] Conventional commit; bump consequence reasoned and stated
- [ ] Human validation gate passed with an explicit OK before any push
- [ ] PR title lint-safe for squash-only repos
- [ ] CI green, or escalated after 2 failed attempts
- [ ] Nothing merged or released without separate approval
