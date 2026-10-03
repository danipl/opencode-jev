## What & why

<!-- One or two sentences: what does this PR change, and what problem does it solve.
     Link issues: Fixes #123 / Relates #123 (omit if none). -->

## How

<!-- Brief approach. Point to docs/DEVELOPMENT.md sections if relevant. -->

## Type of change / commit

Title follows Conventional Commits — it picks the semver bump and writes the changelog:

- [ ] `fix:` → patch
- [ ] `feat:` → minor
- [ ] `feat!:` or `BREAKING CHANGE:` footer → major
- [ ] `chore:` / `docs:` / `refactor:` / `test:` / `ci:` → no release

## Invariants checklist

PRs that break these are rejected. Confirm what applies:

- [ ] Never throw, never hang — every failure path logs and passes the original request through untouched
- [ ] Every path hands back a rebuilt, readable `Request` (including passthroughs via `rebuildRequest`)
- [ ] `tools` array trimmed only — `tool_choice` untouched
- [ ] Responses-API built-in tools (`type !== "function"`) never offered to Jev, never trimmed to
- [ ] Unconfigured = invisible — no `apiKey` → no hook, no log file, zero latency
- [ ] 401/403 latch (`jevAuthFailed`) stays a process-lifetime disable, never a per-request retry

## Hard rules

- [ ] No edits to `dist/`, `package.json` `version`, `CHANGELOG.md`, or release-please files
- [ ] No new runtime dependencies (or justified below)
- [ ] New module-level state is read at module load; tests isolate via cache-busted imports (`?v=N`)
- [ ] New feature has a passthrough/failure-path test (passthrough is the product)

## User-facing changes

- [ ] Config/behavior change → `README.md` and `jev.yaml.example` updated
- [ ] No user-facing change

## Verification

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run build` passes (if touching build output paths)

<!-- Optional: evidence of live behavior — debug log excerpt, local Jev stub run. -->
