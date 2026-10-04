# AGENTS.md

## What this is

`@danipl/opencode-jev` — an OpenCode V2 plugin. It intercepts outbound
inference requests (`http.request` session hook), asks TypeSafe's Jev (a cheap
System-1 model) which tool comes next, and when confident trims the request's
`tools` array to that single tool. The entire plugin is `src/index.ts`
(~500 lines, sectioned: config → request inspection → Jev client →
interception core → transport → entrypoint).

## Commands

```bash
npm run typecheck   # tsc --noEmit — the lint gate (there is no linter config)
npm test            # node --test test/index.test.ts (native TS stripping, Node >= 24)
npm run build       # tsc -> dist/ (only needed for manual OpenCode trials / npm pack)
```

Run all three before pushing. CI (Node 24) gates PRs on commit-message lint +
typecheck + test.

## Load only what you need

| When you are...                  | Read                                                                                                     |
|----------------------------------|----------------------------------------------------------------------------------------------------------|
| Editing `src/index.ts`           | [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) §1–2 — repo map, the one request path, invariants           |
| Writing tests                    | [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) §4 — the black-box seam, cache-buster imports, coverage map |
| Debugging live behavior          | [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) §5 — decision log, local Jev stub, negative tests           |
| Explaining the design or savings | [docs/HOW_IT_WORKS.md](./docs/HOW_IT_WORKS.md)                                                           |
| Touching commits/releases        | [docs/CICD.md](./docs/CICD.md)                                                                           |
| Changing user-facing config      | [README.md](./README.md) + [jev.yaml.example](./jev.yaml.example)                                        |

## Invariants — PRs that break these are rejected

1. **Never throw, never hang.** Every failure path logs and passes the original
   request through untouched.
2. **Always hand back a rebuilt, readable `Request`** — provider bodies are
   one-shot streams; this applies to *every* path, including passthroughs (`rebuildRequest` exists for exactly this).
3. **Trim, don't pin.** Only the `tools` array is modified; `tool_choice` is
   never touched (providers reject forced `tool_choice` in thinking mode, HTTP 400).
4. **Responses-API built-in tools** (`type !== "function"`) are never offered
   to Jev and never trimmed to.
5. **Unconfigured = invisible.** No `apiKey` → no hook registered, no log file,
   zero latency.
6. **The 401/403 latch** (`jevAuthFailed`) disables routing for the process
   lifetime — never turn it into a per-request retry.

## Hard rules

- Never edit: `dist/` (build output), `package.json` `version` (bumped by
  release-please in each release commit), `CHANGELOG.md`,
  `.release-please-manifest.json` — release-please owns all of these.
  `release-please-config.json` is the human-owned *input* config: editing it is
  allowed when release behaviour must change (e.g. `extra-files` stamps the
  version lines in `README.md` marked `x-release-please-version`).
- No new runtime dependencies without strong justification (currently: `yaml`
  only; `@opencode/plugin` is a peer dep).
- Module-level state (captured `fetch`, debug constants, auth latch) is read at **module load**; tests isolate via
  cache-busted imports (`../src/index.ts?v=N`).
  Preserve this pattern if you add module-level state.
- **A new feature without a passthrough/failure-path test is incomplete** —
  passthrough is the product.

## Commits

Conventional Commits are load-bearing — they pick the semver bump and write the
changelog: `fix:` → patch, `feat:` → minor, `revert:` → patch, `!`/`BREAKING CHANGE:`
→ major (minor while pre-1.0, `bump-minor-pre-major`). `chore:` / `docs:` /
`refactor:` / `test:` / `ci:` → no release. `pr.yml`'s `conventional` job lints
every PR commit **and the PR title** (squash-only repo: the title becomes the
`main` commit). Merge to `main` opens a release-please PR; merging that
publishes to npm automatically. No manual tagging or publishing, ever.
