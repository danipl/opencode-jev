// Black-box tests for the jev OpenCode plugin (src/index.ts).
//
// Everything runs through the public seam: default-exported plugin -> setup(ctx)
// -> captured "http.request" hook -> drive events, inspect the (possibly
// rebuilt) request, and inspect the stubbed fetch calls to the Jev API.
//
// The module captures constants (JEV_DEBUG_FILE, JEV_DEBUG_MAX_BYTES) and
// globalThis.fetch at load time, and keeps a mutable jevAuthFailed latch, so
// every test case sets env, stubs fetch, THEN imports a fresh module instance
// via a cache-buster query string.
//
// node:test + node:assert/strict only; TypeScript via native type stripping.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/* ------------------------------------------------------------ harness */

const realFetch = globalThis.fetch;

const ENV_KEYS = [
  "TYPESAFE_API_KEY",
  "JEV_API_URL",
  "JEV_MIN_CONFIDENCE",
  "JEV_MODEL",
  "JEV_TIMEOUT_MS",
  "JEV_CONFIG_PATH",
  "XDG_CONFIG_HOME",
  "JEV_DEBUG_FILE",
  "JEV_DEBUG",
  "JEV_DEBUG_MAX_BYTES",
];
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jev-test-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = realFetch;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function resetEnv(overrides: Record<string, string>): void {
  for (const key of ENV_KEYS) delete process.env[key];
  // Never touch the real /tmp/opencode-jev.log; never let ~/.config/jev leak in.
  process.env.JEV_DEBUG_FILE = path.join(tempDir(), "jev.log");
  process.env.XDG_CONFIG_HOME = tempDir();
  for (const [key, value] of Object.entries(overrides))
    process.env[key] = value;
}

type FetchCall = { url: string; init: any };
type FetchHandler = (url: string, init: any) => any;

let importSeq = 0;

// Set env + stub fetch, import a fresh plugin instance, run setup with a fake
// ctx, and return the recorded fetch calls plus the captured hook holder.
async function setupPlugin(
  overrides: Record<string, string> = { TYPESAFE_API_KEY: "test-key" },
  fetchHandler?: FetchHandler,
) {
  resetEnv(overrides);
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    if (!fetchHandler) throw new TypeError(`unexpected fetch: ${url}`);
    return fetchHandler(String(url), init);
  }) as typeof fetch;
  const mod = await import(`../src/index.ts?v=${importSeq++}`);
  const holder: { captured: ((event: any) => Promise<void>) | undefined } = {
    captured: undefined,
  };
  await mod.default.setup({
    options: {},
    location: { directory: tempDir() },
    session: {
      hook: async (_name: string, cb: any) => {
        holder.captured = cb;
      },
    },
  });
  return { calls, holder };
}

function jevResponse(answer: unknown, status = 200): Response {
  return new Response(JSON.stringify({ answers: { next_tool: answer } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function choice(choiceName: string, confidence: number) {
  return { type: "choice", choice: choiceName, confidence };
}

function postEvent(url: string, body: string, kind = "primary") {
  return {
    kind,
    request: new Request(url, {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    }),
  };
}

function jsonEvent(url: string, payload: unknown, kind = "primary") {
  return postEvent(url, JSON.stringify(payload), kind);
}

async function bodyJson(event: any): Promise<any> {
  return JSON.parse(await event.request.text());
}

function anthropicPayload() {
  return {
    model: "claude-sonnet-4-5",
    tools: [
      { name: "read", input_schema: {} },
      { name: "bash", input_schema: {} },
    ],
    tool_choice: "auto", // string: object tool_choice is ineligible by design
    messages: [
      { role: "user", content: "please list files" },
      { role: "assistant", content: "on it" },
    ],
  };
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";

/* ------------------------------------------------------------- tests */

test("1. no apiKey anywhere: no hook registered", async () => {
  const { holder, calls } = await setupPlugin({});
  assert.equal(holder.captured, undefined);
  assert.equal(calls.length, 0);
});

test("2. config file beats env (first defined value wins)", async () => {
  const cfgPath = path.join(tempDir(), "jev.yaml");
  writeFileSync(cfgPath, "minConfidence: 0.95\n");
  const { calls, holder } = await setupPlugin({
    TYPESAFE_API_KEY: "test-key",
    JEV_CONFIG_PATH: cfgPath,
    JEV_MIN_CONFIDENCE: "0.1",
  });
  assert.ok(holder.captured);
  const payload = anthropicPayload();
  const event = jsonEvent(ANTHROPIC_URL, payload);
  await holder.captured!(event);
  // File minConfidence 0.95 wins over env 0.1 -> answer 0.9 is passthrough.
  assert.deepEqual(await bodyJson(event), payload);
  assert.equal(calls.length, 1);
});

test("3. non-primary kind (title) untouched, no fetch", async () => {
  const { calls, holder } = await setupPlugin();
  assert.ok(holder.captured);
  const payload = anthropicPayload();
  const event = jsonEvent(ANTHROPIC_URL, payload, "title");
  const before = event.request;
  await holder.captured!(event);
  assert.equal(event.request, before); // early return: same object
  assert.deepEqual(await bodyJson(event), payload);
  assert.equal(calls.length, 0);
});

test("4. non-target URL and non-POST method untouched, no fetch", async () => {
  const { calls, holder } = await setupPlugin();
  assert.ok(holder.captured);
  // Non-target URL, POST.
  const payload = anthropicPayload();
  const e1 = jsonEvent("https://example.com/foo", payload);
  await holder.captured!(e1);
  assert.deepEqual(await bodyJson(e1), payload);
  // Target URL, GET (no body).
  const e2 = {
    kind: "primary",
    request: new Request(ANTHROPIC_URL, { method: "GET" }),
  };
  await holder.captured!(e2);
  assert.equal(e2.request.url, ANTHROPIC_URL);
  assert.equal(e2.request.method, "GET");
  assert.equal(calls.length, 0);
});

test("5. anthropic happy path: tools trimmed to chosen tool", async () => {
  const { calls, holder } = await setupPlugin(undefined, () =>
    jevResponse(choice("bash", 0.9)),
  );
  assert.ok(holder.captured);
  const payload = anthropicPayload();
  const event = jsonEvent(ANTHROPIC_URL, payload);
  await holder.captured!(event);

  // Rebuilt request: only the bash tool survives, everything else preserved.
  assert.equal(event.request.url, ANTHROPIC_URL);
  assert.equal(event.request.method, "POST");
  assert.equal(event.request.headers.get("content-length"), null);
  const body = await bodyJson(event);
  assert.deepEqual(body.tools, [{ name: "bash", input_schema: {} }]);
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.model, payload.model);
  assert.deepEqual(body.messages, payload.messages);

  // The Jev API call itself.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, JEV_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-key");
  const jevBody = JSON.parse(calls[0].init.body);
  assert.equal(jevBody.model, "jev-latest");
  assert.equal(typeof jevBody.state, "string");
  assert.ok(jevBody.state.includes("please list files"));
  const criteria = jevBody.questions.next_tool.criteria;
  assert.ok("respond_to_user" in criteria);
  assert.ok("read" in criteria);
  assert.ok("bash" in criteria);
});

test("6. openai chat format: matched via function.name", async () => {
  const { calls, holder } = await setupPlugin(undefined, () =>
    jevResponse(choice("grep", 0.9)),
  );
  assert.ok(holder.captured);
  const payload = {
    model: "gpt-x",
    tools: [
      { type: "function", function: { name: "grep", parameters: {} } },
      { type: "function", function: { name: "edit", parameters: {} } },
    ],
    messages: [{ role: "user", content: "find TODO comments" }],
  };
  const url = "https://api.openai.com/v1/chat/completions";
  const event = jsonEvent(url, payload);
  await holder.captured!(event);
  const body = await bodyJson(event);
  assert.deepEqual(body.tools, [
    { type: "function", function: { name: "grep", parameters: {} } },
  ]);
  assert.deepEqual(body.messages, payload.messages);
  assert.equal(calls.length, 1);
});

test("7. responses format: built-ins excluded from criteria, trimmed by function.name", async () => {
  const { calls, holder } = await setupPlugin(undefined, () =>
    jevResponse(choice("shell", 0.95)),
  );
  assert.ok(holder.captured);
  const payload = {
    model: "gpt-x",
    tools: [
      { type: "web_search" },
      { type: "function", function: { name: "shell" } },
    ],
    input: [{ type: "message", role: "user", content: "run ls" }],
  };
  const url = "https://api.openai.com/v1/responses";
  const event = jsonEvent(url, payload);
  await holder.captured!(event);

  const jevBody = JSON.parse(calls[0].init.body);
  const criteriaKeys = Object.keys(jevBody.questions.next_tool.criteria);
  assert.ok(criteriaKeys.includes("shell"));
  assert.ok(criteriaKeys.includes("respond_to_user"));
  assert.ok(!criteriaKeys.includes("web_search"));

  const body = await bodyJson(event);
  assert.deepEqual(body.tools, [{ type: "function", function: { name: "shell" } }]);
  assert.deepEqual(body.input, payload.input);
});

test("8. responses with only built-in tools: passthrough, no fetch", async () => {
  const { calls, holder } = await setupPlugin();
  assert.ok(holder.captured);
  const payload = {
    model: "gpt-x",
    tools: [{ type: "web_search" }],
    input: [{ type: "message", role: "user", content: "search the web" }],
  };
  const url = "https://api.openai.com/v1/responses";
  const event = jsonEvent(url, payload);
  await holder.captured!(event);
  assert.deepEqual(await bodyJson(event), payload);
  assert.equal(calls.length, 0);
});

test("9. low confidence (0.5 < default 0.75): unchanged", async () => {
  const { calls, holder } = await setupPlugin(undefined, () =>
    jevResponse(choice("bash", 0.5)),
  );
  assert.ok(holder.captured);
  const payload = anthropicPayload();
  const event = jsonEvent(ANTHROPIC_URL, payload);
  await holder.captured!(event);
  assert.deepEqual(await bodyJson(event), payload);
  assert.equal(calls.length, 1);
});

test("10. respond_to_user at 0.99: unchanged", async () => {
  const { calls, holder } = await setupPlugin(undefined, () =>
    jevResponse(choice("respond_to_user", 0.99)),
  );
  assert.ok(holder.captured);
  const payload = anthropicPayload();
  const event = jsonEvent(ANTHROPIC_URL, payload);
  await holder.captured!(event);
  assert.deepEqual(await bodyJson(event), payload);
  assert.equal(calls.length, 1);
});

test("11. choice not among payload tools: unchanged", async () => {
  const { calls, holder } = await setupPlugin(undefined, () =>
    jevResponse(choice("nope", 0.99)),
  );
  assert.ok(holder.captured);
  const payload = anthropicPayload();
  const event = jsonEvent(ANTHROPIC_URL, payload);
  await holder.captured!(event);
  assert.deepEqual(await bodyJson(event), payload);
  assert.equal(calls.length, 1);
});

test("12a. jev fetch rejects (network): unchanged, no throw", async () => {
  const { calls, holder } = await setupPlugin(undefined, () => {
    throw new TypeError("fetch failed");
  });
  assert.ok(holder.captured);
  const payload = anthropicPayload();
  const event = jsonEvent(ANTHROPIC_URL, payload);
  await holder.captured!(event); // must not throw
  assert.deepEqual(await bodyJson(event), payload);
  assert.equal(calls.length, 1);
  // Log contract: a thrown round-trip still ends in exactly one bypass line.
  const logText = readFileSync(process.env.JEV_DEBUG_FILE!, "utf8");
  assert.match(logText, /\[jev\] jev round-trip threw: /);
  assert.match(logText, /\[jev\] bypass: jev unavailable/);
});

test("12b. jev HTTP 500: unchanged", async () => {
  const { calls, holder } = await setupPlugin(undefined, () =>
    new Response("boom", { status: 500 }),
  );
  assert.ok(holder.captured);
  const payload = anthropicPayload();
  const event = jsonEvent(ANTHROPIC_URL, payload);
  await holder.captured!(event);
  assert.deepEqual(await bodyJson(event), payload);
  assert.equal(calls.length, 1);
});

test("13. 401 latches: second request skips jev entirely", async () => {
  const { calls, holder } = await setupPlugin(undefined, () =>
    new Response("nope", { status: 401 }),
  );
  assert.ok(holder.captured);
  const payload = anthropicPayload();
  const e1 = jsonEvent(ANTHROPIC_URL, payload);
  await holder.captured!(e1);
  assert.deepEqual(await bodyJson(e1), payload);
  assert.equal(calls.length, 1);
  // Same module instance: latch is set, no second round-trip.
  const e2 = jsonEvent(ANTHROPIC_URL, anthropicPayload());
  await holder.captured!(e2);
  assert.deepEqual(await bodyJson(e2), payload);
  assert.equal(calls.length, 1);
});

test("14. malformed JSON body: rebuilt with exact original text", async () => {
  const { calls, holder } = await setupPlugin();
  assert.ok(holder.captured);
  const raw = "not json{{";
  const event = postEvent(ANTHROPIC_URL, raw);
  await holder.captured!(event); // must not throw
  assert.equal(await event.request.text(), raw);
  assert.equal(event.request.url, ANTHROPIC_URL);
  assert.equal(event.request.method, "POST");
  assert.equal(calls.length, 0);
});

test("15. ineligible payloads: tool_choice none / empty tools -> no fetch", async () => {
  const { calls, holder } = await setupPlugin();
  assert.ok(holder.captured);
  const p1 = { ...anthropicPayload(), tool_choice: "none" };
  const e1 = jsonEvent(ANTHROPIC_URL, p1);
  await holder.captured!(e1);
  assert.deepEqual(await bodyJson(e1), p1);

  const p2 = { ...anthropicPayload(), tools: [] };
  const e2 = jsonEvent(ANTHROPIC_URL, p2);
  await holder.captured!(e2);
  assert.deepEqual(await bodyJson(e2), p2);
  assert.equal(calls.length, 0);
});

test("16a. malformed jev answer (missing type): passthrough", async () => {
  const { holder } = await setupPlugin(undefined, () =>
    jevResponse({ choice: "bash", confidence: 0.9 }),
  );
  assert.ok(holder.captured);
  const payload = anthropicPayload();
  const event = jsonEvent(ANTHROPIC_URL, payload);
  await holder.captured!(event);
  assert.deepEqual(await bodyJson(event), payload);
});

test("16b. malformed jev answer (non-numeric confidence): passthrough", async () => {
  const { holder } = await setupPlugin(undefined, () =>
    jevResponse({ type: "choice", choice: "bash", confidence: "0.9" }),
  );
  assert.ok(holder.captured);
  const payload = anthropicPayload();
  const event = jsonEvent(ANTHROPIC_URL, payload);
  await holder.captured!(event);
  assert.deepEqual(await bodyJson(event), payload);
});

test("17. jev timeout aborts: passthrough, no hang", async () => {
  const { calls, holder } = await setupPlugin(
    { TYPESAFE_API_KEY: "test-key", JEV_TIMEOUT_MS: "50" },
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(init.signal.reason ?? new Error("aborted"));
        });
      }),
  );
  assert.ok(holder.captured);
  const payload = anthropicPayload();
  const event = jsonEvent(ANTHROPIC_URL, payload);
  await holder.captured!(event); // resolves via abort, must not hang or throw
  assert.deepEqual(await bodyJson(event), payload);
  assert.equal(calls.length, 1);
  // Log contract: a timeout abort still ends in exactly one bypass line.
  const logText = readFileSync(process.env.JEV_DEBUG_FILE!, "utf8");
  assert.match(logText, /\[jev\] jev round-trip threw: /);
  assert.match(logText, /\[jev\] bypass: jev unavailable/);
});

test("18. rebuild fallback throws: original returned, no stranding escape", async () => {
  const { calls, holder } = await setupPlugin();
  assert.ok(holder.captured);
  // Ineligible payload (no tools): body reads fine, only the final fallback
  // rebuild runs. Patch globalThis.Request after the event is built so
  // rebuildRequest's `new Request(...)` throws.
  const event = postEvent(ANTHROPIC_URL, JSON.stringify({ model: "m" }));
  const original = event.request;
  const RealRequest = globalThis.Request;
  globalThis.Request = (function throwingRequest() {
    throw new TypeError("rebuild boom");
  }) as unknown as typeof Request;
  try {
    await holder.captured!(event); // must not throw out of handleRequest
  } finally {
    globalThis.Request = RealRequest;
  }
  // Fallback hands back the original object, and the hook-level catch was
  // never reached: handleRequest absorbed the rebuild failure itself.
  assert.equal(event.request, original);
  assert.equal(calls.length, 0);
  const logText = readFileSync(process.env.JEV_DEBUG_FILE!, "utf8");
  assert.match(logText, /\[jev\] rebuild fallback failed \(/);
  assert.doesNotMatch(logText, /http\.request hook failed/);
});

test("19. body read fails (stream errors mid-read): original returned, no jev call", async () => {
  const { calls, holder } = await setupPlugin();
  assert.ok(holder.captured);
  // duplex:"half" is required for a ReadableStream body; erroring the
  // controller in start() makes request.text() reject mid-read — the
  // body-read guard path.
  const event = {
    kind: "primary",
    request: new Request(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      duplex: "half",
      body: new ReadableStream({
        start(controller) {
          controller.error(new Error("boom"));
        },
      }),
    }),
  };
  const original = event.request;
  await holder.captured!(event); // must not throw
  assert.equal(event.request, original); // guard hands back the original object
  assert.equal(calls.length, 0); // no jev round-trip was made
  const logText = readFileSync(process.env.JEV_DEBUG_FILE!, "utf8");
  assert.match(logText, /\[jev\] bypass: body read failed/);
});

test("20. single function tool: passthrough, no fetch", async () => {
  const { calls, holder } = await setupPlugin();
  assert.ok(holder.captured);
  const payload = {
    ...anthropicPayload(),
    tools: [{ name: "read", input_schema: {} }],
  };
  const event = jsonEvent(ANTHROPIC_URL, payload);
  await holder.captured!(event);
  assert.deepEqual(await bodyJson(event), payload);
  assert.equal(calls.length, 0); // nothing for jev to decide, no round-trip
});
