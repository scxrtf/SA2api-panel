// Run against an isolated production build, a fake PostgREST database and
// loopback upstreams. Optional real CLI: WB2A_TEST_CODEX=1.
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { findCodex } from "../workers/workspace/codex";
import { childEnv } from "../workers/workspace/files";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Assertions inspect the dynamic wire JSON.
type Obj = Record<string, any>;
const key = "wb2a-verify-gateway-key";
const modelId = "fixture:gpt-5.4";
const dist = process.env.WB2A_NEXT_DIST_DIR ?? ".runtime/responses-verify-next";
const development = process.env.WB2A_TEST_NEXT_DEV === "1";
const rows = new Map<string, Obj>();
const errors: unknown[] = [];
let chatCalls = 0;

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
}
const fixture = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const url = new URL(request.url!, fixtureUrl);
    switch (url.pathname) {
      case "/chat/v1/models": return json(response, { data: [{ id: "gpt-5.4" }] });
      case "/chat/v1/chat/completions": {
        chatCalls++;
        assert.equal(request.headers.authorization, "Bearer fake-chat-key");
        assert.equal(body.model, "gpt-5.4");
        const message = { role: "assistant", content: "responses e2e ok" };
        const usage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 };
        if (!body.stream) return json(response, { choices: [{ index: 0, message, finish_reason: "stop" }], usage });
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`);
        response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`);
        return;
      }
      case "/db/rest/Account": case "/db/rest/ApiKey": case "/db/rest/Setting": return json(response, []);
      case "/db/rest/Provider": return json(response, [{ id: "fixture-row", name: "fixture", models: "", baseUrl: fixtureUrl + "/chat/v1", apiKey: "fake-chat-key" }]);
      case "/db/rest/UsageEvent": case "/db/rest/RequestLog": return json(response, [{ id: "fixture-log" }], 201);
      case "/db/rest/GatewayResponse": {
        assert.equal(request.headers.authorization, "Bearer fake-postgrest-key");
        const id = url.searchParams.get("id")?.replace(/^eq\./, "");
        if (request.method === "POST") {
          const [data] = body as Obj[];
          assert.match(data.id, /^[a-f0-9]{64}$/);
          assert.equal(url.searchParams.get("select"), "id");
          rows.set(data.id, { ...data, createdAt: new Date().toISOString() });
          return json(response, [{ id: data.id }], 201);
        }
        if (request.method === "GET") {
          assert.match(url.searchParams.get("createdAt") ?? "", /^gte\./);
          assert.equal(url.searchParams.get("limit"), "1");
          return json(response, id && rows.has(id) ? [rows.get(id)] : []);
        }
        assert.equal(request.method, "DELETE");
        assert.equal(url.searchParams.get("select"), "id");
        return json(response, id && rows.delete(id) ? [{ id }] : []);
      }
      default: assert.fail(`Unexpected fixture route: ${request.method} ${url.pathname}`);
    }
  } catch (error) { errors.push(error); json(response, { error: "fixture assertion failed" }, 500); }
});

await new Promise<void>((done) => fixture.listen(0, "127.0.0.1", done));
const fixtureUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;

const portReservation = createServer();
await new Promise<void>((done) => portReservation.listen(0, "127.0.0.1", done));
const port = (portReservation.address() as { port: number }).port;
await new Promise<void>((done) => portReservation.close(() => done()));
const gateway = `http://127.0.0.1:${port}`;
const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", development ? "dev" : "start", "-H", "127.0.0.1", "-p", String(port)], {
  windowsHide: true, detached: development && process.platform !== "win32", env: {
    ...childEnv(), NODE_ENV: development ? "development" : "production", NODE_PATH: process.env.NODE_PATH, NEXT_TELEMETRY_DISABLED: "1",
    WB2A_NEXT_DIST_DIR: dist, WB2A_DISABLE_SCHEDULER: "1", WB2_WORKSPACE_ENABLED: "0",
    WB2API_MODEL_JSON_DISABLE: "1", WB2A_API_KEY: key, USE_CLOUDBASE_REST: "1", CLOUDBASE_POSTGREST_URL: fixtureUrl + "/db/rest",
    CLOUDBASE_API_KEY: "fake-postgrest-key", WB2A_RESPONSES_UPSTREAM: "", WB2A_RESPONSES_KEY: "", WB2A_RESPONSES_MODELS: "",
    DATABASE_URL: "postgresql://offline:offline@127.0.0.1:1/gateway?connect_timeout=1", DIRECT_URL: "postgresql://offline:offline@127.0.0.1:1/gateway?connect_timeout=1",
  },
});
let output = "";
next.stdout?.on("data", (chunk) => { output = (output + chunk).slice(-5000); });
next.stderr?.on("data", (chunk) => { output = (output + chunk).slice(-5000); });
const closed = new Promise((done) => next.once("close", done));
let home: string | undefined;

try {
  let ready = false;
  for (let i = 0; i < 100 && next.exitCode === null; i++) {
    if (await fetch(gateway + "/api/livez").then((value) => value.ok).catch(() => false)) { ready = true; break; }
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(ready, output);
  const send = (path: string, method = "GET", body?: Obj) => fetch(gateway + path, {
    method, headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  const modelList = await send("/v1/models");
  assert.equal(modelList.status, 200);
  assert.ok((await modelList.json()).data.some((model: Obj) => model.id === modelId));

  // Commonly pasted Base URLs: clients append /responses (some append
  // /v1/responses). Exercise real Next routing so the dynamic [id] handler's
  // automatically generated POST 405 cannot regress.
  for (const path of [
    "/api/v1/responses/responses", "/v1/responses/responses", "/v1/responses/responses/",
    "/api/v1/responses/v1/responses", "/v1/responses/v1/responses",
    "/api/v1/chat/completions/responses", "/api/v1/chat/completions/v1/responses",
    "/api/v1/v1/responses", "/v1/v1/responses", "/responses", "/api/responses",
  ]) {
    const alias = await send(path, "POST", { model: modelId, input: "alias smoke", store: false });
    const payload = await alias.json().catch(() => null);
    assert.equal(alias.status, 200, path + ": " + JSON.stringify(payload));
    assert.equal(payload.output[0].content[0].text, "responses e2e ok");
  }
  for (const path of ["/models", "/api/v1/responses/models", "/v1/responses/v1/models"]) {
    const catalog = await send(path);
    assert.equal(catalog.status, 200, path);
    assert.ok((await catalog.json()).data.some((model: Obj) => model.id === modelId));
  }
  const unsigned = await fetch(gateway + "/api/v1/responses/responses", {
    method: "POST", body: "{}", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(unsigned.status, 401);
  assert.equal((await unsigned.json()).error.code, "invalid_api_key");
  const wrongMethod = await send("/v1/responses");
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST, OPTIONS");
  assert.equal((await wrongMethod.json()).error.code, "method_not_allowed");
  const preflight = await send("/api/v1/responses/responses", "OPTIONS");
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("allow"), "POST, OPTIONS");

  const reply = await send("/v1/responses", "POST", { model: modelId, input: "smoke test" });
  const result = await reply.json();
  assert.equal(reply.status, 200, JSON.stringify(result));
  assert.equal(result.output[0].content[0].text, "responses e2e ok");
  const lookup = await send(`/api/v1/responses/${result.id}`);
  assert.deepEqual(await lookup.json(), result);
  const inputs = await send(`/v1/responses/responses/${result.id}/input_items?limit=1`);
  assert.equal((await inputs.json()).data[0].content[0].text, "smoke test");
  const deleted = await send(`/v1/responses/${result.id}`, "DELETE");
  assert.equal((await deleted.json()).deleted, true);
  assert.equal((await send(`/v1/responses/${result.id}`)).status, 404);
  assert.equal(rows.size, 0);
  const stream = await send("/api/v1/responses/responses", "POST", { model: modelId, input: "stream smoke", stream: true, store: false });
  assert.equal(stream.status, 200);
  assert.match(await stream.text(), /response\.output_text\.delta.*responses e2e ok.*response\.completed/s);
  console.log(`PASS Next ${development ? "development" : "production"} Responses 405 regressions, HTTP aliases, auth, storage, retrieve/list/delete, and SSE`);

  if (process.env.WB2A_TEST_CODEX === "1") {
    const beforeCodex = chatCalls;
    const binary = findCodex();
    assert.ok(binary, "Codex CLI is required for WB2A_TEST_CODEX=1");
    home = await mkdtemp(join(tmpdir(), "wb2a-responses-codex-"));
    const cwd = join(home, "project");
    await mkdir(cwd);
    await writeFile(join(home, "config.toml"), [
      `model = "${modelId}"`, 'model_provider = "fixture"', 'web_search = "disabled"',
      'sandbox_mode = "read-only"', 'approval_policy = "never"',
      // Deliberately paste the full endpoint: the real CLI appends /responses.
      "[model_providers.fixture]", 'name = "Local gateway QA"', `base_url = "${gateway}/v1/responses"`, 'wire_api = "responses"',
      'env_key = "WB2A_TEST_GATEWAY_KEY"', 'requires_openai_auth = false', 'supports_websockets = false', 'stream_max_retries = 0',
      "[analytics]", "enabled = false", "",
    ].join("\n"));
    const exec = promisify(execFile);
    const run = exec(binary, ["exec", "--json", "--skip-git-repo-check", "Reply with plain text only."], {
      cwd, windowsHide: true, timeout: 30_000, maxBuffer: 512 * 1024,
      env: { ...childEnv(), CODEX_HOME: home, WB2A_TEST_GATEWAY_KEY: key },
    });
    run.child.stdin?.end();
    const { stdout } = await run.catch((error) => { throw new Error(String(error.stdout || error.message).slice(-4000)); });
    const events = stdout.split(/\r?\n/).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
    assert.ok(events.some(({ type }) => type === "turn.completed"), stdout);
    assert.ok(events.some(({ item }) => item?.text === "responses e2e ok"), stdout);
    assert.equal(chatCalls, beforeCodex + 1);
    console.log("PASS installed Codex CLI completed a real turn through the Chat-backed Responses endpoint");
  }
  assert.deepEqual(errors, []);
} finally {
  if (development && next.pid && next.exitCode === null) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(next.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
    } else {
      try { process.kill(-next.pid, "SIGTERM"); } catch { /* already stopped */ }
    }
  }
  if (next.exitCode === null) next.kill();
  await closed;
  fixture.closeAllConnections();
  await new Promise<void>((done) => fixture.close(() => done()));
  if (home) {
    assert.equal(dirname(resolve(home)), resolve(tmpdir()));
    assert.ok(basename(home).startsWith("wb2a-responses-codex-"));
    try { await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (error) {
      // Windows can keep SQLite files pinned briefly after Codex has emitted its
      // last event. Surface the isolated scratch path without masking test results.
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      console.warn(`Codex verification scratch directory is still locked: ${home}`);
    }
  }
}
