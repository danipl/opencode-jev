# CI/CD — Release Pipeline

This repository releases through [release-please](https://github.com/googleapis/release-please)
plus GitHub Actions. Versions, tags, changelogs, GitHub Releases and the npm
publish are fully automated. Nobody bumps `package.json` by hand and nobody
pushes tags by hand.

## The flow

```
conventional commit ──push main──▶ release-please opens/updates a Release PR
                                        │
                                   merge PR
                                        ▼
        CHANGELOG.md + package.json/manifest bump + tag vX.Y.Z
                    + GitHub Release (all created by release-please)
                                        │
                            release_created == true
                                        ▼
                    workflow_call → release.yml: build, stamp version
                    from tag, publish @danipl/opencode-jev to npm
```

Note the last hop is an explicit `workflow_call` chain inside
`release-please.yml`, not a tag-push trigger — see
[Why the publish job is chained](#why-the-publish-job-is-chained).

## Version source of truth: the tag; package.json follows it

The **tag `vX.Y.Z` is what the published version comes from**. With
`release-type: node`, release-please *also* bumps `package.json` +
`package-lock.json` inside the release commit itself — the "version pushed
back to the repository" visible in history (e.g.
`chore(main): release 1.0.0`). The tag and the release commit's
`package.json` always agree. At publish time, CI re-stamps the version from
the tag, in the runner's ephemeral checkout only:

```bash
npm version "${GITHUB_REF_NAME#v}" --no-git-tag-version --allow-same-version
```

On the automated path this is a no-op (the checkout already matches the tag);
it is the safety net for a human-pushed emergency tag. Nothing extra is
committed back. release-please's in-repo bookkeeping is
`.release-please-manifest.json` (last released version, used to compute the
next bump) and `CHANGELOG.md`.

## 1. Commits decide the bump

Every commit merged to `main` is read by release-please. The Conventional
Commit prefix determines the semver bump:

| Bump | Version change | Commit type | Example |
| --- | --- | --- | --- |
| patch | 0.1.0 → 0.1.1 | `fix:` | `fix: handle empty tool list` |
| patch | 0.1.0 → 0.1.1 | `revert:` (visible in changelog's "Reverts") | `revert: "feat: add retry fallback"` |
| minor | 0.1.0 → 0.2.0 | `feat:` | `feat: add retry fallback` |
| major | 0.x → 1.0.0 | `!` suffix or `BREAKING CHANGE:` footer | `feat!: rename config key` |

(A `revert:` commit does not un-release anything — semver never goes
backwards; it just lands as its own patch entry.)

Breaking-change variants that all work:

```
feat!: drop jev.yaml v1 format
```

```
fix: remove legacy config loader

BREAKING CHANGE: jev.yaml v1 format is no longer supported.
```

Commits with the other allowed prefixes (`chore:`, `docs:`, `refactor:`,
`test:`, `ci:`) never trigger a release: release-please filters hidden types
out *before* versioning, so they do not appear in the changelog even when a
release PR is open — unless they carry `!` / a `BREAKING CHANGE:` footer, in
which case the breaking note counts and the release bumps.

Note how "no bump" works: the versioning strategy counts only breaking and
`feat` commits and defaults the rest to patch. A commit-only-`chore:` push
opens no release PR because hidden-type commits are filtered out upstream,
not because patch was declined for them.

Because the package is pre-1.0 and `release-please-config.json` sets
`bump-minor-pre-major: true`, **breaking changes are minor bumps while the
version is below 1.0.0** (`0.4.0 → 0.5.0`, not `1.0.0`). From 1.0.0 onward
the table above applies literally: `feat!:` → major. To cross 1.0.0,
release-please needs a breaking change *after* the config flag is removed
(or a `RELEASE AS: 1.0.0` commit footer, which forces any version).

## 2. The Release PR

On every push to `main`, `.github/workflows/release-please.yml` runs
`googleapis/release-please-action@v4`:

- If no release is pending, it does nothing.
- Once at least one release-worthy commit (`feat:`/breaking) lands, it opens a
  single PR titled `chore: release <version>` that contains:
  - a generated `CHANGELOG.md` entry,
  - the new version in the release-please manifest,
  - the new version in `package.json` + `package-lock.json` (`release-type: node`).
- Further qualifying commits merged to `main` are folded into the same open
  PR — its title and changelog update automatically.

**Releasing = merging that PR.** Review it (it should contain only the version
bump and changelog), then squash-merge it — the repo is squash-only, and the
release PR's own title (`chore: release X.Y.Z`) already satisfies the commit
lint.

> Do not edit the release PR's version or changelog by hand — the action
> regenerates the PR body from the commits. Close/reopen or let the next push
> to `main` recreate it instead.
>
> Never **rename the release PR's branch** — `release-please--branches--main…`
> is how the action finds "its" PR. Renaming orphans it: the next push opens a
> second release PR and the stale one never self-heals. Also don't rely on
> editing the PR title — it gets regenerated from the pending commits on every
> run.

### Reverting a merged PR

`git revert` writes `Revert "feat: …"` as the subject, which fails the commit
lint. Squash-merge the revert PR with the Conventional form instead:

```
revert: "feat: add retry fallback"
```

(revert of a `feat:` = patch bump, listed under "Reverts" in the changelog;
semver never goes backwards on its own.)

## 3. Tag + GitHub Release

Merging the release PR makes the action:

1. create the tag `vX.Y.Z` on the merged commit (no component prefix — see
   `include-component-in-tag: false` in the config),
2. create the GitHub Release with the changelog text as notes.

This is the "tag created automatically" step: publishing the release is a
side effect of merging, not something done in the Releases UI.

## 4. npm publish

`release.yml` runs as a reusable workflow (`workflow_call`) from the chained
`publish` job in `release-please.yml`, checking out the freshly created tag.
It:

1. `npm ci && npm run build`,
2. stamps the version from the tag into the ephemeral checkout:
   `npm version "${TAG#v}" --no-git-tag-version --allow-same-version`
   (no-op on the automated path — the release commit already carries it;
   safety net for emergency human-pushed tags),
3. `npm publish --provenance --access public --tag latest` using
   `secrets.NPM_TOKEN` — every release moves both addresses users can install:
   the exact version (`@danipl/opencode-jev@0.2.0`) and `latest`
   (`@danipl/opencode-jev@latest`, or bare `@danipl/opencode-jev`), so users
   stay auto-updated. `--tag latest` is explicit so the rolling tag moves even
   if a release is ever stamped from a prerelease-looking version.

### Why the publish job is chained

GitHub Actions rule: *events (tag pushes, releases) created through the
default `GITHUB_TOKEN` do not trigger new workflow runs* — loop protection.
release-please creates its tags with `GITHUB_TOKEN`, so a plain
`on: push: tags` trigger would silently never fire for automated releases.
Chaining via `workflow_call` sidesteps this without needing a personal access
token. The `push: tags: ["v*"]` trigger on `release.yml` is kept only for
human-pushed emergency tags (a tag pushed by a person *does* fire it, and
release-please tags never double-publish).

## Files

| Path | Purpose |
| --- | --- |
| `.github/workflows/release-please.yml` | Runs the release-please action on `main`; chains npm publish on release |
| `.github/workflows/release.yml` | Builds, stamps version from tag, publishes to npm |
| `release-please-config.json` | Release strategy (node — bumps package.json/lock in the release commit, pre-major minor bumps, plain `v` tags) |
| `.release-please-manifest.json` | Last-released version bookkeeping (drives next bump) |
| `package.json` `version` | Bumped by release-please in each release commit — release-please owns it, never hand-edit |
| `CHANGELOG.md` | Generated on merge of each release PR |
