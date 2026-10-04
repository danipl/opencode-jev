# Developer Guide

How to work on this plugin: architecture you must know before editing, unit
testing, manual testing against a local OpenCode, and the PR → release flow.
For the release pipeline details see [CICD.md](./CICD.md).

## 1. Where to start — repo map

| Path                                                          | Role                                                                                                             |
|---------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------|
| `src/index.ts`                                                | The entire plugin (~500 lines): config loading, request inspection, Jev client, `http.request` hook. Start here. |
| `test/index.test.ts`                                          | Black-box suite (19 tests) driving the plugin through its public seam.                                           |
| `index.js`                                                    | Directory-plugin entry: re-exports `./dist/index.js` so OpenCode can load a checkout path directly.              |
| `dist/`                                                       | `tsc` output — gitignored, never edit; regenerate with `npm run build`.                                          |
| `jev.yaml.example`                                            | User-facing config template.                                                                                     |
| `release-please-config.json`, `.release-please-manifest.json` | release-please bookkeeping. Do not hand-edit (see §6).                                                           |
| `.github/workflows/pr.yml`                                    | CI on every PR and push to `main`: Conventional-commit lint (commits + PR title) → `npm ci` → `typecheck` → `test` (Node 24). |
| `.github/workflows/release-please.yml` + `release.yml`        | Release-PR automation + chained npm publish.                                                                     |

Toolchain: TypeScript strict, ESM (`"type": "module"`), one runtime dep (`yaml`), `@opencode/plugin` as peer/dev dep. No
bundler, no lint config —
`tsc --noEmit` is the linter.

## 2. Architecture: the one request path

Everything happens inside a single OpenCode V2 session hook. The flow of one
upstream inference request:

```
Plugin.define({ id:"jev" }).setup(ctx)
  └─ loadConfig(ctx.options, baseDir)      # 7-layer merge, first defined value wins
     └─ no apiKey → return; ZERO footprint (no hook registered)
  └─ ctx.session.hook("http.request", cb)
       cb(event):
         event.kind !== "primary" → return            # skip title/compaction
         handleRequest(cfg, event.request)
           ├─ targetOf(url)          # anthropic | openai | responses | undefined
           ├─ non-POST / no body     → untouched
           ├─ text = await request.text()              # body is a ONE-SHOT stream
           ├─ JSON.parse fails       → rebuild with original text
           ├─ eligible(payload)?     # has tools, tool_choice not "none"/object
           │    └─ routePayload:
           │         toolNames() → stateOf() → askJev()  # POST cfg.apiUrl
           │         ├─ auth latch set (401/403) → pass  # no round-trip, ever after
           │         ├─ low confidence / respond_to_user / unknown choice → pass
           │         └─ else: payload.tools = [chosen]  # TRIM, never pin tool_choice
           └─ rebuildRequest(request, newBody)          # strip stale content-length
```

Section markers in `src/index.ts` mirror this: `config` → `request
inspection` → `Jev client` → `interception core` → `transport` → `entrypoint`.

### Invariants — PRs that break these are rejected

1. **Never throw, never hang.** Every failure path logs and lets the original
   request through. The reasoning model executing a *bad* tool list is fine;
   a broken session is not.
2. **Always hand back a readable `Request`.** Provider bodies are one-shot
   streams — once you call `.text()` the caller must receive a rebuilt
   `Request`, *including on every passthrough path* (`rebuildRequest` exists
   for exactly this).
3. **Trim, don't pin.** Providers reject forced `tool_choice` in thinking
   mode (HTTP 400, verified live). Only the `tools` array is modified;
   `tool_choice` is passed through byte-for-byte.
4. **Responses-API built-ins are never offered to Jev** (`toolNames` skips
   `type !== "function"`) — they cannot be trimmed-to-one either.
5. **Unconfigured = invisible.** No hook, no log file touched, no latency.
6. **The 401/403 latch** (`jevAuthFailed`) disables routing for the process
   lifetime; don't turn it into a per-request retry.

### Config precedence (first *defined* value wins per field)

`$JEV_CONFIG_PATH` file → `./jev.config.{yaml,yml,json}` →
`./.opencode/jev.{yaml,json}` → `~/.config/jev/config.{yaml,json}` →
plugin `options` (directory-package registrations only) → env (`TYPESAFE_API_KEY` / `JEV_API_URL` /
`JEV_MIN_CONFIDENCE`).
`JEV_MODEL` / `JEV_TIMEOUT_MS` are env-only extras. Constants like
`JEV_DEBUG_FILE` are captured at **module load**, not at setup.

## 3. Dev setup

```bash
npm install
npm run typecheck     # tsc --noEmit — the lint gate
npm test              # node --test, no build step needed
npm run build         # tsc → dist/ (only needed for manual OpenCode testing / packing)
```

Node ≥ 24 recommended (CI pins 24; tests rely on native TS type stripping —
`test/index.test.ts` imports `../src/index.ts` directly).

## 4. Unit testing

`npm test` → `node --test test/index.test.ts`. Plain `node:test` +
`node:assert/strict`; no runner framework.

### The seam

Tests are black-box against the **public contract only**:

```ts
const {calls, holder} = await setupPlugin(envOverrides, fetchHandler);
await holder.captured!(event);              // drive one http.request event
assert.deepEqual(await bodyJson(event), …)
; // inspect (possibly rebuilt) request
calls[n]                                     // inspect stubbed Jev API calls
```

`setupPlugin` does the whole harness: `resetEnv` → stub `globalThis.fetch` → **fresh module import with a `?v=`
cache-buster** → `mod.default.setup(fakeCtx)`
→ capture the hook callback.

### Why the cache-buster

`src/index.ts` captures `globalThis.fetch` and `JEV_DEBUG_FILE`-style
constants **at module load** and owns process-lifetime state (`jevAuthFailed`). Node's ESM cache would hand you a stale
module, so every
case imports `../src/index.ts?v=${importSeq++}`. If you add module-level
mutable state, this is the mechanism that isolates it per test.

### Isolation rules the harness already enforces

- `JEV_DEBUG_FILE` → temp dir (never touches your real `/tmp/opencode-jev.log`).
- `XDG_CONFIG_HOME` → temp dir (your real `~/.config/jev` can't leak in).
- All `JEV_*`/`TYPESAFE_*` env keys are cleared per case and restored in `after()`.

### Adding a test

Copy the nearest existing case. Useful fixtures at the top of the file:
`anthropicPayload()`, `jsonEvent()/postEvent()` (event builder),
`jevResponse(choice(...))` / `choice(name, confidence)` (stub Jev replies),
`bodyJson(event)` (read the final request body).

Map your change to the suite's coverage pattern — each safety branch has a
test: no-key (§1), config precedence (§2), non-primary/non-target skip (§3–4), each wire format (§5–7), every
passthrough reason (§8–12b, 15–17),
auth latch (§13), one-shot-body fidelity (§14). **A new feature without a
passthrough/failure-path test is incomplete** — passthrough is the product.

## 5. Manual testing with a local OpenCode

### Fast loop (checkout as directory plugin)

```bash
npm run build   # index.js re-exports dist/, so build before every trial
```

```jsonc
// ~/.config/opencode/opencode.jsonc  (or project opencode.jsonc)
{ "plugins": ["/absolute/path/to/opencode-jev"] }
```

OpenCode's directory loader resolves `<dir>/index.js` → your `dist/`. After
editing `src/`, rerun `npm run build` and restart OpenCode (the plugin
instance and its env capture are created at setup).

### Configure the plugin after registering it

Registration alone does nothing — the plugin self-disables without an
`apiKey`. Three configuration routes; per field, the first source with a
defined value wins (full precedence list in §2).

**A. Inline options (object registration) — best for dev.** The config
`plugins` array accepts `{ package, options }` objects; `options` is
delivered verbatim as `ctx.options`:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-jev",
      "options": {
        "apiKey": "apikey_...", // required
        "apiUrl": "https://api.typesafe.ai/v1/systemone", // optional: point at a stub
        "minConfidence": 0.8,
        "model": "jev-latest"
      }
    }
  ]
}
```

Gotchas: `options` only arrives for this object/package form — a plain
string registration or a file auto-discovered under
`.opencode/plugins/` gets `{}`; and as config layer 5 it **loses** to any
`jev.config.*` / `~/.config/jev` file that defines the same field. The
`package` path may be absolute, `./`-relative to the declaring config file,
or a `file://` URL, and must be a **directory**, not a `.js` file.

**B. Config file — `cp jev.yaml.example …`, set `apiKey`.** Pick one:

| Location | Scope |
| --- | --- |
| `$JEV_CONFIG_PATH` | explicit, anywhere (YAML or JSON) |
| `<project>/jev.config.yaml` | per project — `<project>` = the dir OpenCode runs in, not the plugin dir |
| `<project>/.opencode/jev.yaml` | per project |
| `~/.config/jev/config.yaml` | global (honors `XDG_CONFIG_HOME`) |

**C. Environment (lowest precedence, but zero files):**

```bash
export TYPESAFE_API_KEY="***"   # also: JEV_API_URL, JEV_MIN_CONFIDENCE
```

Env vars must be visible to the **OpenCode server process** — export them in
the shell you launch `opencode` from (a macOS GUI-launched app won't see your
zsh exports; use route A or B there). The debug/behavior knobs
`JEV_MODEL`, `JEV_TIMEOUT_MS`, `JEV_DEBUG`, `JEV_DEBUG_FILE`,
`JEV_DEBUG_MAX_BYTES` are **env-only**, read once at module load — put them
in the shell you start OpenCode from.

### Watch it work

```bash
tail -f /tmp/opencode-jev.log
# [jev] active: https://api.typesafe.ai/v1/systemone minConfidence=0.75
# [jev] apply: tools trimmed to bash only (bash@0.91 >= minConfidence 0.75)
# [jev] bypass: jev says answer directly (respond_to_user@0.99) — nothing to trim to, full tool list sent untouched
# [jev] jev http 401 (invalid key, routing disabled)
```

The log file exists because OpenCode's background service discards plugin
`console` output. `JEV_DEBUG=1` also echoes to stdout (foreground runs).

### Reading the decision log

Every eligible provider request ends in exactly **one** tagged line. Grep
the tag to classify all traffic:

```bash
grep -c 'apply:'  /tmp/opencode-jev.log   # requests where jev acted
grep -c 'bypass:' /tmp/opencode-jev.log   # requests handed to the LLM untouched
```

| Line | Meaning | What the reasoning model received |
| --- | --- | --- |
| `apply: tools trimmed to X only (X@0.91 >= minConfidence 0.75)` | **jev acted.** Its pick cleared the threshold. | Only tool `X` — it executes instead of deciding. |
| `bypass: jev choice X@0.53 below minConfidence 0.8 — ...` | Jev picked a tool but wasn't sure enough. | Full tool list, normal deliberation. |
| `bypass: jev says answer directly (respond_to_user@0.81) — ...` | Jev voted "no tool needed". Never forces this — trimming has nothing to target, and stripping all tools on a cheap model's word is too destructive. | Full tool list; the big model may still answer directly or use a tool. |
| `bypass: jev choice X is not among this request's tools — ...` | Jev hallucinated/held a stale tool name. | Full tool list. |
| `bypass: jev choice X listed but missing from payload — ...` | Name passed the criteria list but matched no payload entry (format mismatch edge case). | Full tool list. |
| `bypass: jev unavailable (see preceding 'jev ...' error line) — ...` | The round-trip failed; the **preceding** error line names why. | Full tool list. |

Error/context lines that precede a `bypass: jev unavailable`:

| Line | Meaning |
| --- | --- |
| `jev http 500` (or any non-401/403 status) | Transient provider failure — plugin keeps trying next request. |
| `jev http 401 (invalid key, routing disabled)` | **Latched off.** Auth failed; all later requests bypass silently with zero jev round-trips and **no further log lines**. Fix the key and restart OpenCode. |
| `jev answer malformed` | Jev's JSON didn't parse into `{choice, confidence}`. |
| `jev round-trip threw: ...` | The round-trip itself threw: fetch network error, timeout abort, or non-JSON body. |

Fallback lines that need no Jev decision (the request is sent with its tools
untouched, or as-read): `bypass: body read failed (...)` (the body stream
errored while being read; the original object is handed back because there is
nothing readable to rebuild), `intercept failed, falling back to untouched
request: ...` (unexpected plugin-side error; the original body is re-sent
byte-for-byte), and `rebuild fallback failed (...)` (even the byte-for-byte
rebuild threw; the consumed original is passed through as the last resort).

Silent paths (no log line by design, request simply untouched):
non-POST / non-target URLs, non-primary `event.kind` (title, compaction),
payloads with no usable tools, and everything after the 401 latch. If the
log goes quiet mid-session, check for a latch line first.

### Verify trimming actually happened

Start any OpenCode session that triggers tool use; in the log, `apply:`
means the outbound request's `tools` array was trimmed to the chosen tool
and the model had no choice. Confirm the session behaves normally — that's
the whole safety contract.

### Inspect the exact Jev round-trip with a local stub

No real API key needed — point `JEV_API_URL` at a stub that echoes what the
plugin sends and picks a tool:

```js
// /tmp/jev-stub.mjs — pick "read" with high confidence, log the request
import http from "node:http";

http.createServer(async (req, res) => {
    const body = await new Promise((r) => {
        let d = "";
        req.on("data", (c) => (d += c));
        req.on("end", () => r(d));
    });
    console.log(body);
    res.end(JSON.stringify({answers: {next_tool: {type: "choice", choice: "read", confidence: 0.99}}}));
}).listen(9999);
```

```bash
node /tmp/jev-stub.mjs &
export JEV_API_URL=http://localhost:9999 TYPESAFE_API_KEY=***
```

The echoed body is exactly what Jev sees (`state`, `criteria`, `model`).
Returning `"read"` at 0.99 makes the log show `apply: tools trimmed to read
only ...` on every request that offers the `read` tool — proof the trim path
works end to end without a network dependency — keep the trial session
short, every tool turn is now a `read`. Change `choice` to
`"respond_to_user"` or `confidence` to `0.1` to watch the `bypass:` paths
live.

### Negative tests worth doing by hand

- **Bad key** → one `jev http 401` line, then every request routes around
  Jev with zero added latency; session unaffected.
- **No key / no config** → no `[jev] active` line, no log file written,
  byte-identical behavior to plugin-less OpenCode.
- **Jev endpoint down** (`JEV_API_URL=http://localhost:1`) → `pass-through
  (jev unavailable)` logs, 2 s worst-case stall, nothing breaks.

### Packaging check (what npm users get)

```bash
npm pack          # then: tar -tzf danipl-opencode-jev-<version>.tgz
```

The tarball must contain `dist/index.js`, `index.js`, `README.md`, `LICENSE`,
`jev.yaml.example` (the `files` list). The npm install path resolves through
`package.json` `exports` → `./dist/index.js` instead of the `index.js`
directory shim — same compiled file, so a working checkout trial already
covers the runtime; `npm pack` only guards the packaging contract.

## 6. Making a PR

### Branch & commit

1. Branch from `main` (`git switch -c feat/retry-fallback`).
2. Conventional Commits are **load-bearing** — they pick the semver bump and
   write the changelog after merge:

   | Prefix | Effect |
         | --- | --- |
   | `fix:` | patch bump (→ release PR) |
   | `feat:` | minor bump (→ release PR) |
   | `revert:` | patch bump, "Reverts" changelog entry (semver never goes backwards) |
   | `!` suffix or `BREAKING CHANGE:` footer | major bump — **minor while pre-1.0** (`bump-minor-pre-major`, see [CICD.md](./CICD.md) §1) |
   | `chore:` / `docs:` / `refactor:` / `test:` / `ci:` | no release, hidden from changelog |

   `pr.yml`'s `conventional` job enforces this before merge: every commit in
   the PR **and the PR title** must match — the repo is squash-only, so the
   title becomes the `main` commit that release-please reads. A non-Conventional
   commit would otherwise reach `main` and be skipped by release-please
   *silently*. Details in [CICD.md](./CICD.md) §1.

3. Before pushing: `npm run typecheck && npm test && npm run build`.
4. **Never** touch `package.json` `version` (release-please bumps it in the
   release commit),
   `CHANGELOG.md`, or `.release-please-manifest.json` — release-please owns
   them; a PR editing them is rejected at review.

### CI

`.github/workflows/pr.yml` runs on every PR: the `conventional` job lints
every commit message **and the PR title** against the table above, then `ci`
runs `npm ci` → `npm run typecheck` → `npm test` (Node 24). Both jobs must be
green to merge.

### PR body should state

- What changed and why (link the issue if any).
- Which of the §2 invariants the change touches, and how the tests prove the
  passthrough paths still hold.
- For config/format changes: a manual-test note from §5 (what you ran
  against a live OpenCode, what the log showed).

### After merge — you're done, the machines release

Merge to `main` → release-please opens/updates a `chore: release X.Y.Z` PR →
merging **that** creates the tag, GitHub Release, changelog, and npm publish
automatically. No manual tagging, no local `npm publish`.

## 7. The full SDLC in one picture

```
issue/idea
  └─ branch from main
      └─ edit src/index.ts (+ add black-box tests)
          └─ npm run typecheck && npm test          ← fast loop
              └─ npm run build → local OpenCode trial, tail the debug log
                  └─ commit (conventional!) → push → PR
                      └─ pr.yml: commit/title lint + typecheck + test   ← gate
                          └─ review → squash-merge to main (only allowed mode)
                              ├─ pr.yml re-runs on main
                              └─ release-please: release PR → merge
                                  └─ tag + GitHub Release + npm publish
                                      └─ users' OpenCode auto-installs the bump
```
