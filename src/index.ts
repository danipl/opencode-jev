import { parse as parseYaml } from "yaml";
import { appendFileSync, renameSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Plugin } from "@opencode/plugin";

/**
 * jev — route tool selection through TypeSafe's System-1 (Jev) model (V2 plugin).
 *
 * Problem: the expensive reasoning model (Anthropic/OpenAI) burns tokens just
 * deciding which tool to call next. This plugin registers the V2 native-HTTP
 * session hook ("http.request") to observe upstream inference requests as
 * they leave the OpenCode server. When Jev picks one of the request's
 * tools with enough confidence, the plugin trims the request's tools array to
 * just that tool, so the reasoning model executes instead of deciding among
 * a dozen candidates. Trimming (not pinning via tool_choice) was chosen
 * because providers reject forced tool_choice in thinking mode (HTTP 400,
 * verified live). Bonus: dropped tool schemas shrink the request.
 *
 * Note: the hook transport replaced an earlier globalThis.fetch patch — live
 * verification showed OpenCode V2 sends provider traffic through its own HTTP
 * client, which never touches the patched global fetch.
 *
 * Covered wire formats (matched by path, so any OpenAI/Anthropic-compatible
 * gateway works, incl. OpenCode Zen/Go endpoints): Anthropic Messages
 * (/v1/messages), OpenAI Chat Completions (/chat/completions), OpenAI
 * Responses (/responses). Responses-API built-in tools (web_search,
 * namespaces, ...) are never offered to Jev since tool_choice cannot pin them.
 *
 * Safety: low confidence, "respond_to_user", reasoning/thinking-mode requests
 * (providers reject forced tool_choice there — verified live), network
 * failure, timeout, or any parse error leaves the request untouched — Jev
 * must never break a session. All failures are swallowed and mirrored to
 * /tmp/opencode-jev.log.
 *
 * Config sources (first defined value wins per field):
 *   1. $JEV_CONFIG_PATH file (JSON or YAML)
 *   2. ./jev.config.yaml / ./jev.config.yml
 *   3. ./jev.config.json
 *   4. ./.opencode/jev.yaml / ./.opencode/jev.json
 *   5. ~/.config/jev/config.yaml / config.json
 *   6. plugin options (ctx.options; only delivered when registered as a
 *      directory package under "plugins", not for auto-discovered files)
 *   7. env TYPESAFE_API_KEY / JEV_API_URL / JEV_MIN_CONFIDENCE
 * Extras: JEV_MODEL (default "jev-latest"), JEV_TIMEOUT_MS (default 2000).
 *
 * Logging: OpenCode's background service discards plugin console output, so
 * every decision is appended to /tmp/opencode-jev.log (override with
 * JEV_DEBUG_FILE). JEV_DEBUG=1 additionally echoes to stdout.
 */

interface JevConfig {
  apiKey: string;
  apiUrl: string;
  minConfidence: number;
  timeoutMs: number;
  model: string;
}

type RawConfig = Record<string, unknown>;

type Target = "anthropic" | "openai" | "responses";

interface JevAnswer {
  choice: string;
  confidence: number;
}

const DEFAULT_API_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MIN_CONFIDENCE = 0.75;
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_MODEL = "jev-latest";
const STATE_CHAR_BUDGET = 8000;
const TURN_CHAR_BUDGET = 2000;
const RECENT_TURNS = 4;
// TypeSafe choice questions accept at most 255 criteria; one slot is reserved
// for respond_to_user.
const MAX_CRITERIA = 255;

// Explicit function reference for the Jev client, captured at module load.
const nativeFetch = globalThis.fetch.bind(globalThis) as typeof fetch;

// OpenCode's background service swallows plugin console output, so mirror
// every line to a grep-able file. JEV_DEBUG=1 additionally echoes to stdout
// (useful when running plugins in foreground).
// Capped at JEV_DEBUG_MAX_BYTES (default 256 KiB): when exceeded, the file
// is rotated once to <file>.1 and a fresh file starts. Prevents unbounded
// growth in long-lived background services.
const debugFile = process.env.JEV_DEBUG_FILE ?? "/tmp/opencode-jev.log";
const maxLogBytes = (() => {
  const raw = Number(process.env.JEV_DEBUG_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 256 * 1024;
})();
function log(...args: unknown[]): void {
  const line = `[jev] ${args.map((arg) => String(arg)).join(" ")}`;
  if (process.env.JEV_DEBUG === "1") console.log(line);
  try {
    try {
      if (statSync(debugFile).size > maxLogBytes) {
        try {
          renameSync(debugFile, `${debugFile}.1`);
        } catch {
          // Fall through to plain append when rotation fails.
        }
      }
    } catch {
      // File does not exist yet — nothing to rotate.
    }
    appendFileSync(debugFile, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Never break a session over a log line.
  }
}

// Latched on the first 401/403 from the Jev API: the key is invalid, so all
// later requests skip the Jev round-trip entirely (zero added latency) and
// pass through untouched. Reset only by service restart.
let jevAuthFailed = false;

/* ------------------------------------------------------------------ config */

function parseConfigText(
  filePath: string,
  text: string,
): RawConfig | undefined {
  try {
    const data: unknown = /\.ya?ml$/i.test(filePath)
      ? parseYaml(text)
      : JSON.parse(text);
    return typeof data === "object" && data !== null
      ? (data as RawConfig)
      : undefined;
  } catch {
    return undefined;
  }
}

async function fileConfig(filePath: string): Promise<RawConfig | undefined> {
  try {
    return parseConfigText(filePath, await readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function expandHome(candidate: string): string {
  return candidate === "~" || candidate.startsWith("~/")
    ? path.join(os.homedir(), candidate.slice(candidate === "~" ? 1 : 2))
    : candidate;
}

function envConfig(): RawConfig {
  const cfg: RawConfig = {};
  if (process.env.TYPESAFE_API_KEY) cfg.apiKey = process.env.TYPESAFE_API_KEY;
  if (process.env.JEV_API_URL) cfg.apiUrl = process.env.JEV_API_URL;
  if (process.env.JEV_MIN_CONFIDENCE)
    cfg.minConfidence = Number(process.env.JEV_MIN_CONFIDENCE);
  return cfg;
}

async function configLayers(
  options: RawConfig,
  baseDir: string,
): Promise<RawConfig[]> {
  const configRoot =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  const files = [
    ...(process.env.JEV_CONFIG_PATH
      ? [expandHome(process.env.JEV_CONFIG_PATH)]
      : []),
    ...["jev.config.yaml", "jev.config.yml", "jev.config.json"].map((name) =>
      path.join(baseDir, name),
    ),
    ...["jev.yaml", "jev.json"].map((name) =>
      path.join(baseDir, ".opencode", name),
    ),
    ...["config.yaml", "config.json"].map((name) =>
      path.join(configRoot, "jev", name),
    ),
  ];
  const layers: RawConfig[] = [];
  for (const file of files) {
    const layer = await fileConfig(file);
    if (layer) layers.push(layer);
  }
  layers.push(options, envConfig());
  return layers;
}

function pickString(layers: RawConfig[], key: string): string | undefined {
  for (const layer of layers) {
    const value = layer[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function pickNumber(layers: RawConfig[], key: string): number | undefined {
  for (const layer of layers) {
    const raw = layer[key];
    const value = typeof raw === "string" ? Number(raw) : raw;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function loadConfig(
  options: RawConfig,
  baseDir: string,
): Promise<JevConfig | undefined> {
  const layers = await configLayers(options, baseDir);
  const apiKey = pickString(layers, "apiKey");
  if (!apiKey) return undefined;
  const confidence =
    pickNumber(layers, "minConfidence") ?? DEFAULT_MIN_CONFIDENCE;
  return {
    apiKey,
    apiUrl: pickString(layers, "apiUrl") ?? DEFAULT_API_URL,
    minConfidence: Math.min(Math.max(confidence, 0), 1),
    timeoutMs: positiveIntFromEnv("JEV_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    model:
      pickString(layers, "model") ?? process.env.JEV_MODEL ?? DEFAULT_MODEL,
  };
}

/* ------------------------------------------------------ request inspection */

function targetOf(url: string): Target | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const { hostname, pathname } = parsed;
  if (hostname === "api.anthropic.com" || pathname.endsWith("/v1/messages")) {
    return "anthropic";
  }
  // OpenAI Responses API (/v1/responses). Checked before the api.openai.com
  // host catch-all: that host also serves this different wire format.
  if (pathname.endsWith("/responses")) {
    return "responses";
  }
  if (hostname === "api.openai.com" || pathname.endsWith("/chat/completions")) {
    return "openai";
  }
  return undefined;
}

function toolNames(tools: unknown[]): string[] {
  const names: string[] = [];
  for (const tool of tools) {
    if (typeof tool !== "object" || tool === null) continue;
    const record = tool as {
      name?: unknown;
      type?: unknown;
      function?: { name?: unknown };
    };
    // Responses API built-ins (web_search, file_search, namespace groups, ...)
    // cannot be pinned via tool_choice, so only keep plain function tools.
    if (record.type !== undefined && record.type !== "function") continue;
    const name =
      typeof record.name === "string"
        ? record.name
        : typeof record.function?.name === "string"
          ? record.function.name
          : undefined;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOf).join(" ");
  if (typeof content === "object" && content !== null) {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if ("content" in record) return textOf(record.content);
  }
  return "";
}

function stateOf(payload: Record<string, unknown>): string {
  // Anthropic/OpenAI chat carry `messages`; the Responses API carries `input`
  // items of type "message".
  const conversation = Array.isArray(payload.messages)
    ? payload.messages
    : Array.isArray(payload.input)
      ? payload.input
      : [];
  const turns = conversation
    .filter(
      (m): m is { role: string; content: unknown } =>
        typeof m === "object" &&
        m !== null &&
        ((m as { type?: unknown }).type === undefined ||
          (m as { type?: unknown }).type === "message") &&
        ((m as { role?: unknown }).role === "user" ||
          (m as { role?: unknown }).role === "assistant"),
    )
    .map((m) => ({
      role: m.role,
      text: textOf(m.content).slice(0, TURN_CHAR_BUDGET),
    }))
    .filter((turn) => turn.text.length > 0);
  const recent = turns.slice(-RECENT_TURNS);
  const firstUser = turns.find((turn) => turn.role === "user");
  const picked =
    firstUser && !recent.includes(firstUser) ? [firstUser, ...recent] : recent;
  return JSON.stringify(picked).slice(0, STATE_CHAR_BUDGET);
}

/* ------------------------------------------------------------ Jev client */

async function askJev(
  cfg: JevConfig,
  state: string,
  names: string[],
): Promise<JevAnswer | undefined> {
  const criteria: Record<string, string> = {
    respond_to_user: "Task is complete, or clarification from user is required",
  };
  for (const name of names.slice(0, MAX_CRITERIA - 1))
    criteria[name] = `Use tool ${name}`;

  const response = await nativeFetch(cfg.apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      state,
      model: cfg.model,
      questions: {
        next_tool: {
          type: "choice",
          instructions: "Which tool should the coding agent execute next?",
          criteria,
        },
      },
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!response.ok) {
    // Invalid key: latch off so every later request passes through with no
    // added latency. Any other status is transient — keep trying.
    if (response.status === 401 || response.status === 403) {
      jevAuthFailed = true;
      log(`jev http ${response.status} (invalid key, routing disabled)`);
    } else {
      log(`jev http ${response.status}`);
    }
    return undefined;
  }
  const payload = (await response.json()) as {
    answers?: {
      next_tool?: { type?: unknown; choice?: unknown; confidence?: unknown };
    };
  };
  const answer = payload.answers?.next_tool;
  if (
    !answer ||
    answer.type !== "choice" ||
    typeof answer.choice !== "string" ||
    typeof answer.confidence !== "number" ||
    !Number.isFinite(answer.confidence)
  ) {
    log("jev answer malformed");
    return undefined;
  }
  return { choice: answer.choice, confidence: answer.confidence };
}

/* --------------------------------------------------- interception core */

async function routePayload(
  cfg: JevConfig,
  target: Target,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const names = toolNames(payload.tools as unknown[]);
  if (names.length === 0) return false;
  // Invalid key latched earlier: skip the round-trip, zero added latency.
  if (jevAuthFailed) return false;
  const answer = await askJev(cfg, stateOf(payload), names);
  if (
    !answer ||
    answer.choice === "respond_to_user" ||
    !names.includes(answer.choice) ||
    answer.confidence < cfg.minConfidence
  ) {
    log(
      `pass-through${answer ? ` (jev: ${answer.choice}@${answer.confidence})` : " (jev unavailable)"}`,
    );
    return false;
  }
  // Force by trimming the candidate set to the chosen tool instead of pinning
  // via tool_choice: providers reject forced tool_choice in thinking mode
  // (verified live: HTTP 400), while a single offered tool is always valid.
  // Side benefit: dropped tool schemas shrink the request substantially.
  // tool_choice itself is left exactly as OpenCode sent it.
  const tools = (payload.tools as unknown[]).filter((tool) => {
    if (typeof tool !== "object" || tool === null) return false;
    const record = tool as {
      name?: unknown;
      function?: { name?: unknown };
    };
    return (
      record.name === answer.choice || record.function?.name === answer.choice
    );
  });
  if (tools.length === 0) {
    log(`pass-through (chosen tool ${answer.choice} not found in payload)`);
    return false;
  }
  payload.tools = tools;
  log(`forced ${answer.choice} confidence=${answer.confidence}`);
  return true;
}

function eligible(payload: Record<string, unknown>): boolean {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return false;
  const choice = payload.tool_choice;
  return (
    choice === undefined ||
    choice === null ||
    (typeof choice === "string" && choice !== "none")
  );
}

/* --------------------------------------------- transport: http.request hook */

// Rebuild a provider Request preserving everything except content-length,
// which is stale once the body changes (the transport recomputes it).
function rebuildRequest(request: Request, body: string): Request {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body,
  });
}

async function handleRequest(
  cfg: JevConfig,
  request: Request,
): Promise<Request> {
  const target = targetOf(request.url);
  if (!target || request.method.toUpperCase() !== "POST" || !request.body) {
    return request;
  }
  // Provider bodies are one-shot streams: once read, the caller must get a
  // readable Request back — even on every failure/passthrough path.
  const text = await request.text();
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    if (payload && typeof payload === "object" && eligible(payload)) {
      const forced = await routePayload(cfg, target, payload);
      return rebuildRequest(request, forced ? JSON.stringify(payload) : text);
    }
  } catch (error) {
    log(`intercept failed, falling back to untouched request: ${error}`);
  }
  return rebuildRequest(request, text);
}

/* ------------------------------------------------------------- entrypoint */

export default Plugin.define({
  id: "jev",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as RawConfig;
    const baseDir = ctx.location.directory ?? process.cwd();
    const cfg = await loadConfig(options, baseDir);
    if (!cfg) {
      // Fully transparent when unconfigured: no hook registered, zero
      // overhead, and no log file touched (console only under JEV_DEBUG).
      if (process.env.JEV_DEBUG === "1")
        console.log("[jev] disabled: no apiKey found in any config source");
      return;
    }
    await ctx.session.hook("http.request", async (event) => {
      // Agent-loop calls only; title/compaction/generate requests have no
      // tool decision to save.
      if (event.kind !== "primary") return;
      try {
        event.request = await handleRequest(cfg, event.request);
      } catch (error) {
        log(`http.request hook failed, request untouched: ${error}`);
      }
    });
    log(`active: ${cfg.apiUrl} minConfidence=${cfg.minConfidence}`);
  },
});
