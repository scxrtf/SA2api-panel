import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { gunzipSync } from "node:zlib";
import { POST } from "../src/app/api/v1/responses/route";
import { invalidateEntries } from "../src/lib/pool";
import { ResponsesError, ResponseSseDecoder, type ResponseObject } from "../src/lib/responses-http";
import { prepareBridgeInput } from "../src/lib/responses-input";
import { responsesCodec } from "../src/lib/responses-state";

const webSearch = { type: "web_search", search_context_size: "medium" };
const webSearchPreview = { type: "web_search_preview", search_context_size: "low" };
const webSearchPreviewDated = { type: "web_search_preview_2025_03_11" };
const hostedTypes = [webSearch, webSearchPreview, webSearchPreviewDated];
const fn = { type: "function", name: "lookup", parameters: { type: "object" } };
const base = { model: "cn:kimi-k3.1-pro", input: "hello", store: false };
const codec = responsesCodec("web-search-test", "test-secret-only");
const prepare = (overrides: ResponseObject) => prepareBridgeInput({ ...base, ...overrides }, [], codec);
const key = "gateway-web-search-fixture";
const submit = (body: ResponseObject) => POST(new Request("http://localhost/api/v1/responses", {
  method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
  body: JSON.stringify(body),
}));

function withEnv(t: TestContext, env: Record<string, string>) {
  const originalEnv = Object.keys(env).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function assertNativeRequirement(overrides: ResponseObject, param: RegExp) {
  assert.throws(() => prepare(overrides), (error) => {
    assert.ok(error instanceof ResponsesError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "unsupported_parameter");
    assert.match(error.param ?? "", param);
    assert.match(error.message, /native Responses|disable web search/i);
    return true;
  });
}

test("the WorkBuddy bridge skips optional hosted search without losing Codex's callable tools", () => {
  const functions = Array.from({ length: 16 }, (_, i) => ({ ...fn, name: i === 0 ? "web_search" : "fixture_" + i }));
  const include = ["web_search_call.action.sources", "web_search_call.results", "reasoning.encrypted_content"];
  for (const hosted of hostedTypes) {
    const tools = [...functions, hosted];
    const { chat, aliases, effectiveBody, omittedWebSearch } = prepare({ tools, include, tool_choice: "auto", stream: true });
    assert.deepEqual(chat.tools, functions.map(({ name, parameters }) => ({
      type: "function", function: { name, parameters },
    })));
    assert.deepEqual([...aliases.keys()], functions.map(({ name }) => name));
    assert.equal(chat.tool_choice, "auto");
    assert.equal(chat.stream, true);
    assert.deepEqual(chat.messages, [{ role: "user", content: "hello" }]);
    assert.equal(omittedWebSearch, true);
    assert.deepEqual(effectiveBody.tools, functions);
    assert.deepEqual(effectiveBody.include, ["reasoning.encrypted_content"]);
    assert.deepEqual(tools.at(16), hosted);
  }
  assert.equal(prepare({ tools: [fn] }).omittedWebSearch, false);
});

test("optional hosted-only declarations allow text, but forced search and replay still fail clearly", () => {
  for (const hosted of hostedTypes) {
    for (const choice of ["auto", "none"]) {
      const { chat, aliases, effectiveBody } = prepare({ tools: [hosted], tool_choice: choice });
      assert.deepEqual(chat.messages, [{ role: "user", content: "hello" }]);
      assert.equal(aliases.size, 0);
      assert.equal(chat.tools, undefined);
      assert.equal(chat.tool_choice, undefined);
      assert.deepEqual(effectiveBody.tools, []);
      assert.equal(effectiveBody.tool_choice, choice);
    }
    assertNativeRequirement({ tools: [hosted, fn], tool_choice: { type: hosted.type } }, /^tool_choice/);
    assertNativeRequirement({ tools: [hosted], tool_choice: "required" }, /^tool_choice/);
  }
  const required = prepare({ tools: [webSearch, fn], tool_choice: "required" }).chat;
  assert.equal(required.tool_choice, "required");
  assertNativeRequirement({ tools: [fn], include: ["web_search_call.action.sources"] }, /^include/);
  assertNativeRequirement({
    input: [{ type: "web_search_call", id: "ws_fixture", status: "completed", action: { type: "search", query: "fixture" } }],
  }, /^input/);
  assertNativeRequirement({ tools: [webSearch, { type: "file_search", vector_store_ids: ["vs_fixture"] }] }, /^tools\[1\]/);
  assertNativeRequirement({
    tools: [webSearch, fn],
    tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "web_search" }] },
  }, /^tool_choice/);
});

test("WorkBuddy forwards only callable tools and discloses omitted hosted search in JSON and SSE", async (t) => {
  assert.equal(process.env.WB2API_OFFLINE_TEST, "1", "Use npm test for the offline WorkBuddy transport fixture.");
  withEnv(t, { WB2A_API_KEY: key, WB2_WORKSPACE_ENABLED: "0" });
  const runtime = globalThis as typeof globalThis & { prisma?: unknown };
  const original = runtime.prisma;
  const state = { uid: "web-search-bridge-fixture", disabled: false, paused: false, credits: 100n, cooldownUntil: 0n, breakerUntil: 0n, degradeUntil: 0n };
  const account = { uid: state.uid, nickname: "Fixture", realm: "cn", accessToken: "web-search-pool-fixture", refreshToken: "",
    expiresAt: 0n, domain: "", enterpriseId: "", deviceToken: "", state, modelCooldowns: [], modelCosts: [] };
  runtime.prisma = {
    setting: { findUnique: async () => null },
    account: { findMany: async () => [account], findUnique: async () => null },
    accountState: { findUnique: async () => state, upsert: async () => state },
    modelCooldown: { deleteMany: async () => ({ count: 0 }) },
    stickySession: { findUnique: async () => null, findMany: async () => [], upsert: async () => ({}), delete: async () => ({}) },
    requestLog: { create: async () => ({ id: "web-search-log" }) },
    usageEvent: { create: async () => ({ id: "web-search-usage" }) },
  };
  invalidateEntries();
  t.after(() => { runtime.prisma = original; invalidateEntries(); });
  const fetchMock = t.mock.method(globalThis, "fetch", async (target: string | URL | Request, init?: RequestInit) => {
    const uri = new URL(String(target));
    assert.ok(uri.hostname.endsWith(".workbuddy.cn") && uri.pathname.endsWith("/chat/completions"));
    const wire = init?.body;
    assert.ok(wire);
    const upstream = JSON.parse(typeof wire === "string" ? wire : gunzipSync(Buffer.from(wire as Uint8Array)).toString());
    assert.equal(upstream.model, "kimi-k3.1-pro");
    assert.deepEqual(upstream.tools.map((tool: { type: string; function: { name: string } }) => [tool.type, tool.function.name]), [["function", "lookup"]]);
    const chunk = { choices: [{ index: 0, delta: { role: "assistant", content: "fixture reply" }, finish_reason: "stop" }] };
    return new Response("data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } });
  });
  const request = { ...base, tools: [fn, webSearch], tool_choice: "auto" };
  const json = await submit(request);
  assert.equal(json.headers.get("X-WB2A-Omitted-Tools"), "web_search");
  const result = await json.json();
  assert.equal(json.status, 200, JSON.stringify(result));
  assert.deepEqual(result.tools, [fn]);
  assert.equal(result.output[0].content[0].text, "fixture reply");
  const sse = await submit({ ...request, stream: true });
  assert.equal(sse.status, 200);
  assert.equal(sse.headers.get("X-WB2A-Omitted-Tools"), "web_search");
  const decoder = new ResponseSseDecoder();
  const events = [...decoder.feed(new Uint8Array(await sse.arrayBuffer()))].map((frame) => JSON.parse(frame.data));
  assert.equal(events.find((event) => event.type === "response.output_text.delta")?.delta, "fixture reply");
  assert.deepEqual(events.find((event) => event.type === "response.completed")?.response.tools, [fn]);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("native Responses still receives hosted tool choice and search replay intact", async (t) => {
  const env = {
    USE_CLOUDBASE_REST: "0",
    WB2A_API_KEY: key,
    WB2A_RESPONSES_UPSTREAM: "http://127.0.0.1:9199/provider/v1",
    WB2A_RESPONSES_KEY: "upstream-web-search-fixture",
    WB2A_RESPONSES_MODELS: "native-web-search-fixture",
    WB2_WORKSPACE_ENABLED: "0",
  };
  withEnv(t, env);
  const body = {
    model: env.WB2A_RESPONSES_MODELS,
    tools: [webSearch],
    tool_choice: { type: "web_search" },
    input: [
      { role: "user", content: "continue" },
      { type: "web_search_call", id: "ws_fixture", status: "completed", action: { type: "search", query: "fixture" } },
    ],
    include: ["web_search_call.action.sources"],
    store: false,
  };
  const nativeReply = {
    id: "resp_web_search_fixture", object: "response", status: "completed", store: false,
    output: [{ type: "web_search_call", id: "ws_fixture", status: "completed" }],
  };
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), env.WB2A_RESPONSES_UPSTREAM + "/responses");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer " + env.WB2A_RESPONSES_KEY);
    assert.deepEqual(JSON.parse(String(init?.body)), body);
    return Response.json(nativeReply);
  });
  const response = await submit(body);
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(response.headers.get("X-WB2A-Omitted-Tools"), null);
  assert.deepEqual(result, nativeReply);
  assert.equal(fetchMock.mock.callCount(), 1);
});
