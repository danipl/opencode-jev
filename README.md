# opencode-jev

Route [OpenCode](https://opencode.ai) tool selection through TypeSafe's
System-1 (**Jev**) model.

**Problem:** the expensive reasoning model burns tokens and latency just
deciding *which tool to call next*.

**Fix:** this plugin observes each upstream inference request
(OpenCode V2 `http.request` session hook), asks Jev — a cheap, fast,
calibrated model — which of the request's tools comes next, and when Jev is
confident enough, trims the request's `tools` array down to that single tool.
The reasoning model then *executes* instead of deliberating among a dozen
candidates. Dropped tool schemas also shrink the request.

Trimming (not pinning via `tool_choice`) is deliberate: providers reject
forced `tool_choice` in thinking mode (HTTP 400), while a single offered tool
is always valid.

## Install

```jsonc
// opencode.jsonc — project-level or ~/.config/opencode/
{
  "plugins": ["@danipl/opencode-jev"]
}
```

OpenCode installs the package automatically on next start. Requires OpenCode
**V2** (`Plugin.define` API; V1 hosts reject it).

## Configure

Set an API key by either method:

```bash
export TYPESAFE_API_KEY="apikey_..."
```

or copy [`jev.yaml.example`](./jev.yaml.example) to `jev.yaml` next to your
OpenCode config (or anywhere, pointed to by `JEV_CONFIG_PATH`).

**Unconfigured = fully transparent:** no hook is registered, zero overhead.

Config sources, first defined value wins per field:

1. `$JEV_CONFIG_PATH` file (JSON or YAML)
2. `./jev.config.yaml` / `.yml` / `.json`
3. `./.opencode/jev.yaml` / `jev.json`
4. `~/.config/jev/config.yaml` / `config.json`
5. plugin options (directory-package registrations only)
6. env `TYPESAFE_API_KEY` / `JEV_API_URL` / `JEV_MIN_CONFIDENCE`

| Env var | Default | Meaning |
| --- | --- | --- |
| `JEV_MODEL` | `jev-latest` | Jev model id |
| `JEV_TIMEOUT_MS` | `2000` | Jev round-trip timeout |
| `JEV_DEBUG_FILE` | `/tmp/opencode-jev.log` | decision log path |
| `JEV_DEBUG` | — | `1` echoes the log to stdout |
| `JEV_DEBUG_MAX_BYTES` | `262144` | log rotation cap (one `.1` backup) |

## Safety

Jev must never break a session. The request passes through untouched on:
low confidence, `respond_to_user`, reasoning/thinking-mode payloads, network
failure, timeout, parse errors, or an invalid API key (latched off after the
first 401/403 — zero added latency afterwards). Only primary agent-loop
requests are considered (`event.kind === "primary"`); title/compaction
traffic is skipped.

Wire formats covered (path-matched, any compatible gateway works):
Anthropic Messages (`/v1/messages`), OpenAI Chat Completions
(`/chat/completions`), OpenAI Responses (`/responses`). Responses-API
built-in tools are never offered to Jev.

Every decision is appended to the debug log — `tail -f /tmp/opencode-jev.log`
to watch routing live.

## Development

```bash
npm install
npm run build        # tsc -> dist/
npm pack             # inspect the tarball
```

Local trial without publishing — point OpenCode at the checkout:

```jsonc
{ "plugins": ["/absolute/path/to/opencode-jev"] }
```

## License

MIT
