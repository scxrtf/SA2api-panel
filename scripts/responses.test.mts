import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { POST as create } from "../src/app/api/v1/responses/route";
import { POST as compact } from "../src/app/api/v1/responses/compact/route";
import { POST as count } from "../src/app/api/v1/responses/input_tokens/route";
import { GET as retrieve, DELETE as remove } from "../src/app/api/v1/responses/[id]/route";
import { GET as items } from "../src/app/api/v1/responses/[id]/input_items/route";
import { POST as cancel } from "../src/app/api/v1/responses/[id]/cancel/route";
import { GET as models } from "../src/app/api/v1/models/route";
import { PATCH as grant } from "../src/app/api/panel/keys/[name]/route";
import { invalidateEntries } from "../src/lib/pool";
import { responsesEndpoint } from "../src/lib/responses-gateway";
import { ResponseSseDecoder } from "../src/lib/responses-http";
import { completeBackgroundResponse, responseDigest } from "../src/lib/responses-state";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Assertions inspect the dynamic wire JSON.
type Obj = Record<string, any>;
type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: Obj };
type Row = { id: string; backend: string; model: string; snapshot: string; createdAt: Date };
const KEY = "responses-test-sub", SUB = "responses-test-other", CHAT_ONLY = "responses-chat-only";
const ledger = new Map<string, Row>();
const seen: Seen[] = [];
const failures: unknown[] = [];
const logs: Obj[] = [];
let port: number;
let endingEarly: (() => void) | undefined;
let cancellationAck: () => void;
let stateOffline = false;
let subGrants = "fixture,openai-responses";
const usage = { prompt_tokens: 31, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 12 }, completion_tokens_details: { reasoning_tokens: 3 } };

function sendJSON(res: ServerResponse, value: Obj, status = 200, headers?: Obj) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(value));
}
function chatChunk(delta: Obj, finish_reason: string | null = null) {
  return JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] });
}
function sendFrame(res: ServerResponse, value: string) { res.write(`data: ${value}\r\n\r\n`); }

const nativeCreated = 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_native_stream","object":"response","status":"in_progress"}}\n\n';
const nativeCompleted = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_native_stream","object":"response","status":"completed","output":[]}}\n\n';
const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const url = req.url ?? "";
    seen.push({ method: req.method!, url, headers: req.headers, body });
    if (url === "/chat/v1/models") { sendJSON(res, { data: [{ id: "chat" }] }); return; }
    if (url === "/chat/v1/chat/completions") {
      assert.equal(req.headers.authorization, "Bearer chat-fixture");
      if (body.model === "rate") { sendJSON(res, { error: { code: "rate_limited", message: "try later" } }, 429); return; }
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        sendFrame(res, chatChunk({ reasoning_content: "thinking" }));
        if (body.model === "cancelled") { res.once("close", () => cancellationAck()); return; }
        if (body.model === "interrupted") { res.end(); return; }
        if (body.model === "failure") { sendFrame(res, '{"error":{"code":"failed_fixture","message":"unavailable"}}'); res.end(); return; }
        if (body.model === "truncated") {
          sendFrame(res, chatChunk({ tool_calls: [{ index: 0, id: "call_partial", function: { name: "lookup", arguments: '{"q":' } }] }));
          sendFrame(res, chatChunk({}, "length"));
          res.end("data: [DONE]\r\n\r\n");
          return;
        }
        // Fragment a UTF-8 sequence and CRLF across separate writes. Keep the
        // connection live until the client has actually observed the first delta.
        const utf8 = Buffer.from(`data: ${chatChunk({ content: "你好" })}\r\n\r\n`);
        const boundary = utf8.indexOf(Buffer.from("你")) + 1;
        res.write(utf8.subarray(0, boundary));
        res.write(utf8.subarray(boundary, -1));
        res.write(utf8.subarray(-1));
        endingEarly = () => {
          const fn = body.tools?.[0]?.function?.name ?? "lookup";
          const custom = body.tools?.[1]?.function?.name ?? "edit";
          sendFrame(res, chatChunk({ tool_calls: [
            { index: 0, id: "call_lookup", function: { name: fn.slice(0, 3), arguments: "" } },
            { index: 1, id: "call_edit", function: { name: custom, arguments: '{"input":"line ' } },
          ] }));
          sendFrame(res, chatChunk({ tool_calls: [
            { index: 0, function: { name: fn.slice(3), arguments: '{"query":' } },
            { index: 1, function: { arguments: '1"}' } },
          ] }));
          sendFrame(res, chatChunk({ tool_calls: [{ index: 0, function: { arguments: '"tea"}' } }] }, "tool_calls"));
          sendFrame(res, JSON.stringify({ choices: [], usage }));
          res.end("data: [DONE]\r\n\r\n");
        };
        return;
      }
      const isCompact = String(body.messages?.at(-1)?.content).includes("handoff summary");
      sendJSON(res, { id: "chatcmpl-test", object: "chat.completion", choices: [{ index: 0, finish_reason: "stop",
        message: { role: "assistant", content: isCompact ? "Encrypted context summary." : "兼容成功", annotations: [{ type: "url_citation", url_citation: { start_index: 0, end_index: 2, url: "https://example.test", title: "Fixture" } }] } }], usage });
      return;
    }
    assert.equal(req.headers.authorization, "Bearer native-fixture");
    const path = url.split("?", 1)[0];
    switch (path) {
      case "/native/v1/responses":
        if (body.input === "redirect") { res.writeHead(307, { Location: "/should-not-follow" }).end(); return; }
        if (body.input === "wrong-sse") { sendJSON(res, { object: "response" }); return; }
        if (body.stream) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(nativeCreated); res.end(nativeCompleted); return; }
        sendJSON(res, { id: body.previous_response_id ? "resp_native_follow" : "resp_native", object: "response", status: body.background ? "queued" : "completed", store: body.store !== false,
          output: [{ type: "web_search_call", id: "ws_fixture" }] });
        return;
      case "/native/v1/responses/compact": sendJSON(res, { object: "response.compaction", output: [{ type: "compaction", encrypted_content: "native-fixture" }] }); return;
      case "/native/v1/responses/input_tokens": sendJSON(res, { object: "response.input_tokens", input_tokens: 19 }); return;
      case "/native/v1/responses/resp_native_stream":
        res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(nativeCompleted); return;
      case "/native/v1/responses/resp_native":
        if (req.method === "DELETE") res.writeHead(204).end();
        else sendJSON(res, { object: "response", id: "resp_native", output: [] });
        return;
      case "/native/v1/responses/resp_native/cancel": sendJSON(res, { status: "cancelled" }); return;
      case "/native/v1/responses/resp_native/input_items": sendJSON(res, { object: "list", data: [], has_more: false }); return;
      default: assert.fail(`Unexpected fixture route ${req.method} ${url}`);
    }
  } catch (error) { failures.push(error); res.writeHead(500).end(); }
});

before(async () => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as { port: number }).port;
  process.env.WB2A_SUPER_PASSWORD = "test-secret";
  process.env.WB2_WORKSPACE_ENABLED = "0";
  Object.assign(globalThis, { prisma: {
    setting: { findUnique: async () => null },
    apiKey: { findMany: async () => [
      { name: "test sub", key: KEY, providers: subGrants },
      { name: "other sub", key: SUB, providers: subGrants },
      { name: "chat only", key: CHAT_ONLY, providers: "fixture" },
    ], findUnique: async () => ({ name: "test sub" }), update: async ({ data }: Obj) => { subGrants = data.providers; } },
    account: { findMany: async () => [] },
    provider: { findMany: async () => [{ name: "fixture", apiKey: "chat-fixture", models: "", baseUrl: `http://127.0.0.1:${port}/chat/v1` }] },
    requestLog: { create: async ({ data }: Obj) => { logs.push(data); return { id: "fixture-log" }; } },
    usageEvent: { create: async () => ({ id: "fixture-usage" }) },
    gatewayResponse: {
      async findFirst({ where }: Obj) { const row = ledger.get(where.id); return row && row.createdAt >= where.createdAt.gte ? row : null; },
      async create({ data }: Obj) {
        if (stateOffline) throw new Error("fixture storage offline");
        assert.equal(ledger.has(data.id), false);
        ledger.set(data.id, { ...data, createdAt: new Date() } as Row);
      },
    async upsert({ create }: Obj) { ledger.set(create.id, { ...create, createdAt: new Date() } as Row); },
      async update({ where, data }: Obj) { const row = ledger.get(where.id); if (!row) throw new Error("missing fixture"); Object.assign(row, data); return row; },
      async updateMany({ where, data }: Obj) {
        if (stateOffline) throw new Error("fixture storage offline");
        const row = ledger.get(where.id);
        if (!row) return { count: 0 };
        const excluded = where.snapshot?.not?.contains;
        if (typeof excluded === "string" && String(row.snapshot ?? "").includes(excluded)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      async deleteMany({ where }: Obj) {
        if (where.id) return { count: ledger.delete(where.id) ? 1 : 0 };
        let count = 0;
        for (const [id, row] of ledger) if (row.createdAt < where.createdAt.lt) { ledger.delete(id); count++; }
        return { count };
      },
    },
  } });
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  assert.deepEqual(failures, []);
});

function request(method: string, path = "/api/v1/responses", body?: unknown, key = KEY) {
  return new Request(`http://localhost${path}`, {
    method, headers: { Authorization: "Bearer " + key, "Content-Type": "application/json", "X-Not-Forwarded": "private" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const submit = (body: unknown, key = KEY) => create(request("POST", "/api/v1/responses", body, key));
async function expectJSON(res: Response, status = 200) {
  const body = await res.json() as Obj;
  assert.equal(res.status, status, JSON.stringify(body));
  return body;
}

test("Chat-backed Responses uses pool/provider routing and persists only the caller's state", async () => {
  assert.equal((await expectJSON(await submit({ model: "fixture:chat", input: "hi" }, "bad"), 401)).error.code, "invalid_api_key");
  assert.equal((await expectJSON(await submit([]), 400)).error.code, "invalid_request");
  const value = await expectJSON(await submit({ model: "fixture:chat", instructions: "do not inherit", input: [
    { role: "developer", content: "always JSON" },
    { role: "user", content: [{ type: "input_text", text: "Say hi" }, { type: "input_image", image_url: "data:image/png;base64,eA==", detail: "low" }] },
  ], text: { format: { type: "json_schema", name: "demo", schema: { type: "object" }, strict: true } },
  reasoning: { effort: "low" }, max_output_tokens: 299, metadata: { source: "test" } }));
  assert.equal(value.object, "response"); assert.equal(value.status, "completed");
  assert.equal(value.output[0].content[0].text, "兼容成功");
  assert.equal(value.output[0].content[0].annotations[0].url, "https://example.test");
  assert.deepEqual(value.usage, { input_tokens: 31, output_tokens: 9, total_tokens: 40, input_tokens_details: { cached_tokens: 12 }, output_tokens_details: { reasoning_tokens: 3 } });
  assert.deepEqual(seen.at(-1)?.body.messages[2].content[1], { type: "image_url", image_url: { url: "data:image/png;base64,eA==", detail: "low" } });
  assert.equal(seen.at(-1)?.body.reasoning_effort, "low");
  assert.equal(seen.at(-1)?.body.max_completion_tokens, 299);
  assert.deepEqual(seen.at(-1)?.body.response_format, { type: "json_schema", json_schema: { name: "demo", schema: { type: "object" }, strict: true } });
  const id = value.id;
  assert.equal((await expectJSON(await retrieve(request("GET"), context(id)))).id, id);
  assert.equal((await expectJSON(await retrieve(request("GET", undefined, undefined, SUB), context(id)), 404)).error.code, "response_not_found");
  assert.equal((await expectJSON(await submit({ model: "fixture:chat", previous_response_id: id, input: "continue" }, SUB), 404)).error.code, "previous_response_not_found");
  const one = await expectJSON(await items(request("GET", "/api/v1/responses/x/input_items?limit=1&order=asc"), context(id)));
  assert.equal(one.data[0].role, "developer"); assert.equal(one.has_more, true);
  const two = await expectJSON(await items(request("GET", "/api/v1/responses/x/input_items?limit=1&order=asc&after=" + one.last_id), context(id)));
  assert.equal(two.data[0].role, "user"); assert.equal(two.has_more, false);
  const history = await expectJSON(await submit({ previous_response_id: id, input: "next turn" }));
  assert.equal(history.previous_response_id, id);
  assert.deepEqual(seen.at(-1)?.body.messages.map((m: Obj) => m.role), ["system", "user", "assistant", "user"]);
  assert.equal(seen.at(-1)?.body.messages[0].content, "always JSON");
  assert.equal((await expectJSON(await cancel(request("POST"), context(id)), 400)).error.code, "response_not_cancellable");
  assert.deepEqual(await expectJSON(await remove(request("DELETE"), context(id))), { id, object: "response.deleted", deleted: true });
  assert.equal((await expectJSON(await retrieve(request("GET"), context(id)), 404)).error.code, "response_not_found");
  assert.equal((await expectJSON(await retrieve(request("GET"), context(history.id)))).id, history.id);
});

test("incremental Responses SSE, interleaved function/custom tools, and stateless replay", { timeout: 5000 }, async () => {
  const initial = ledger.size;
  const res = await submit({ model: "fixture:chat", input: "start", store: false, stream: true, include: ["reasoning.encrypted_content"], tools: [
    { type: "namespace", name: "catalog", tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }] },
    { type: "custom", name: "edit", format: { type: "text" } },
  ] });
  assert.equal(res.status, 200); assert.equal(res.headers.get("X-Accel-Buffering"), "no");
  const reader = res.body!.getReader(), decoder = new ResponseSseDecoder();
  const events: Obj[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      for (const frame of decoder.feed(value)) {
        const event = JSON.parse(frame.data);
        assert.equal(frame.event, event.type);
        assert.equal(event.sequence_number, events.length);
        events.push(event);
        if (event.type === "response.output_text.delta") {
          assert.equal(event.delta, "你好");
          assert.ok(endingEarly, "a delta reached the caller before the model ended");
          const finish = endingEarly; endingEarly = undefined; finish();
        }
      }
      if (done) break;
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const final = events.at(-1)!;
  assert.equal(final.type, "response.completed"); assert.equal(final.response.usage.total_tokens, 40);
  assert.ok(events.some((event) => event.type === "response.function_call_arguments.delta"));
  assert.ok(events.some((event) => event.type === "response.custom_tool_call_input.delta"));
  const output = final.response.output as Obj[];
  const fn = output.find((item) => item.type === "function_call")!;
  const custom = output.find((item) => item.type === "custom_tool_call")!;
  assert.deepEqual([fn.name, fn.namespace, fn.call_id, fn.arguments], ["lookup", "catalog", "call_lookup", '{"query":"tea"}']);
  assert.equal(custom.input, "line 1");
  const replay = [ { role: "user", content: "start" }, ...output,
    { type: "function_call_output", call_id: fn.call_id, output: "tea result" },
    { type: "custom_tool_call_output", call_id: custom.call_id, output: "edited" } ];
  await expectJSON(await submit({ model: "fixture:chat", input: replay, store: false }));
  const messages = seen.at(-1)?.body.messages;
  assert.deepEqual(messages.map((m: Obj) => m.role), ["user", "assistant", "tool", "tool"]);
  assert.equal(messages[1].reasoning_content, "thinking");
  assert.equal(messages[1].tool_calls[0].id, fn.call_id);
  assert.equal((await expectJSON(await submit({ model: "fixture:chat", input: replay, store: false }, SUB), 400)).error.code, "invalid_encrypted_content");
  assert.equal(ledger.size, initial);
  assert.equal((await retrieve(request("GET"), context(final.response.id))).status, 404);
  assert.ok(logs.some((log) => log.path === "/v1/responses" && log.stream && log.model === "fixture:chat" && log.errKind === ""));
});

test("disconnect releases the Chat stream and does not claim a completed response", { timeout: 5000 }, async () => {
  const closed = new Promise<void>((done) => { cancellationAck = done; });
  const initial = ledger.size;
  const stream = await submit({ model: "fixture:cancelled", input: "hello", stream: true });
  const reader = stream.body!.getReader(), decoder = new ResponseSseDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      assert.equal(done, false);
      if ([...decoder.feed(value)].some((frame) => frame.event === "response.reasoning_text.delta")) break;
    }
    await reader.cancel();
    await closed;
  } finally { reader.releaseLock(); }
  assert.equal(ledger.size, initial);
});

test("chat failures, incomplete output, explicit compact and unsupported semantics are truthful", async () => {
  for (const model of ["fixture:interrupted", "fixture:failure", "fixture:truncated"]) {
    const res = await submit({ model, input: "hi", stream: true, store: false });
    const events = (await res.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
    const terminal = events.at(-1)!;
    assert(!events.some((event) => event.type === "response.completed" || event.type === "response.function_call_arguments.done"));
    if (model.endsWith(":truncated")) {
      assert.equal(terminal.type, "response.incomplete");
      assert.equal(terminal.response.incomplete_details.reason, "max_output_tokens");
      assert(!events.some((event) => event.type === "response.output_item.done" && event.item.type === "function_call"));
    } else assert.equal(terminal.type, "response.failed");
  }
  assert.equal((await expectJSON(await submit({ model: "fixture:rate", input: "hi" }), 429)).error.code, "rate_limited");
  const queued = await expectJSON(await submit({ model: "fixture:chat", input: "hi", background: true }));
  assert.equal(queued.status, "queued");
  const completed = await expectJSON(await retrieve(request("GET"), context(queued.id)));
  assert.equal(completed.status, "completed");
  assert.equal(completed.background, true);
  const resumed = await retrieve(request("GET", "/api/v1/responses/x?stream=true&starting_after=2"), context(queued.id));
  assert.equal(resumed.headers.get("Content-Type"), "text/event-stream; charset=utf-8");
  const replay = (await resumed.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
  assert.ok(replay.length > 0);
  assert.ok(replay.every((event) => event.sequence_number > 2));
  assert.equal(replay.at(-1).type, "response.completed");
  assert.equal((await expectJSON(await retrieve(request("GET", "/api/v1/responses/x?starting_after=bad"), context(queued.id)), 400)).error.param, "starting_after");
  assert.ok((await expectJSON(await count(request("POST", "/api/v1/responses/input_tokens", { model: "fixture:chat", input: "hi" })))).input_tokens > 0);
  const compacted = await expectJSON(await compact(request("POST", "/api/v1/responses/compact", { model: "fixture:chat", input: "prior question" })));
  assert.equal(compacted.object, "response.compaction");
  assert.equal(compacted.output.at(-1).type, "compaction");
  assert(!JSON.stringify(compacted).includes("Encrypted context summary."));
  await expectJSON(await submit({ model: "fixture:chat", input: [...compacted.output, { role: "user", content: "continue" }], store: false }));
  assert.match(seen.at(-1)?.body.messages[1].content, /Encrypted context summary\./);
  stateOffline = true;
  try {
    assert.equal((await expectJSON(await submit({ model: "fixture:chat", input: "stored" }), 503)).error.code, "responses_storage_unavailable");
    await expectJSON(await submit({ model: "fixture:chat", input: "stateless", store: false }));
  } finally { stateOffline = false; }
});

test("background completion cannot overwrite a cancelled snapshot", async () => {
  const id = "resp_cancelled_fixture";
  const owner = responseDigest("gateway-key", KEY);
  const key = responseDigest("wb2a-response-v1", owner, id);
  const cancelled = { response: { id, object: "response", status: "cancelled", background: true, cancelled_at: 1, output: [] }, input: [], offset: 0 };
  ledger.set(key, { id: key, backend: "chat", model: "fixture:chat", snapshot: JSON.stringify(cancelled), createdAt: new Date() });
  try {
    const completed = { ...cancelled, response: { ...cancelled.response, status: "completed", cancelled_at: undefined } };
    assert.equal(await completeBackgroundResponse(owner, id, completed), false);
    assert.equal(JSON.parse(ledger.get(key)!.snapshot).response.status, "cancelled");
  } finally {
    ledger.delete(key);
  }
});

test("native Responses provides exact HTTP lifecycle forwarding and caller-scoped IDs", async () => {
  Object.assign(process.env, { WB2A_RESPONSES_UPSTREAM: `http://127.0.0.1:${port}/native/v1`, WB2A_RESPONSES_KEY: "native-fixture", WB2A_RESPONSES_MODELS: "native-model" });
  assert.equal(responsesEndpoint(`http://127.0.0.1:${port}/native/v1/responses`, "input_items", "resp_native").pathname, "/native/v1/responses/resp_native/input_items");
  assert.throws(() => responsesEndpoint("https://example.test/v1", "retrieve", "../models"));
  assert.equal((await expectJSON(await submit({ model: "native-model", input: "hi" }, CHAT_ONLY), 403)).error.code, "provider_not_allowed");
  assert.equal((await expectJSON(await submit({ model: "native-model", conversation: "conv_test", input: "hi" }, SUB), 403)).error.code, "native_resource_not_allowed");
  const incoming = { model: "native-model", background: true, store: true, input: [{ type: "input_text", text: "hello" }], tools: [{ type: "web_search" }], reasoning: { effort: "low" } };
  const value = await expectJSON(await submit(incoming, SUB));
  assert.deepEqual(seen.at(-1)?.body, incoming);
  assert.equal(seen.at(-1)?.headers["x-not-forwarded"], undefined);
  assert.equal(value.status, "queued"); assert.equal(value.output[0].type, "web_search_call");
  const id = value.id as string;
  assert.ok([...ledger.values()].some((row) => row.backend.startsWith("native:") && row.snapshot === ""));
  assert.equal((await retrieve(request("GET"), context(id))).status, 404);
  assert.equal((await remove(request("DELETE", undefined, undefined, CHAT_ONLY), context(id))).status, 404);
  const follow = await expectJSON(await submit({ previous_response_id: id, input: "more", store: false }, SUB));
  assert.equal(follow.id, "resp_native_follow");
  assert.equal(seen.at(-1)?.body.model, "native-model");
  assert.equal(seen.at(-1)?.body.previous_response_id, id);
  assert.equal((await retrieve(request("GET", undefined, undefined, SUB), context(follow.id))).status, 404);
  await expectJSON(await retrieve(request("GET", "/api/v1/responses/resp_native?include%5B%5D=reasoning.encrypted_content", undefined, SUB), context(id)));
  assert.match(seen.at(-1)?.url ?? "", /include%5B%5D=reasoning\.encrypted_content/);
  await expectJSON(await items(request("GET", "/api/v1/responses/resp_native/input_items?order=asc&limit=2", undefined, SUB), context(id)));
  assert.match(seen.at(-1)?.url ?? "", /input_items\?order=asc&limit=2/);
  assert.equal((await expectJSON(await cancel(request("POST", undefined, undefined, SUB), context(id)))).status, "cancelled");
  assert.equal((await remove(request("DELETE", undefined, undefined, SUB), context(id))).status, 204);
  assert.equal((await retrieve(request("GET", undefined, undefined, SUB), context(id))).status, 404);
  assert.equal((await expectJSON(await count(request("POST", "/api/v1/responses/input_tokens", { model: "native-model", input: "hi" })))).input_tokens, 19);
  assert.equal((await expectJSON(await compact(request("POST", "/api/v1/responses/compact", { model: "native-model", input: "hi" })))).output[0].encrypted_content, "native-fixture");
  const stream = await submit({ model: "native-model", input: "hello", stream: true });
  assert.equal(await stream.text(), nativeCreated + nativeCompleted);
  const resume = await retrieve(request("GET", "/api/v1/responses/resp_native_stream?stream=true&starting_after=1"), context("resp_native_stream"));
  assert.equal(await resume.text(), nativeCompleted);
  assert.match(seen.at(-1)?.url ?? "", /starting_after=1/);
  assert.equal((await expectJSON(await submit({ model: "native-model", input: "wrong-sse", stream: true }), 502)).error.code, "invalid_responses_stream");
  assert.equal((await expectJSON(await submit({ model: "native-model", input: "redirect" }), 502)).error.code, "responses_upstream_configuration");
  const available = (await expectJSON(await models(request("GET", "/api/v1/models", undefined, SUB)))).data.map((model: Obj) => model.id);
  const filtered = (await expectJSON(await models(request("GET", "/api/v1/models", undefined, CHAT_ONLY)))).data.map((model: Obj) => model.id);
  assert.deepEqual(available, ["native-model", "fixture:chat"]);
  assert.deepEqual(filtered, ["fixture:chat"]);
  const permission = (providers: string[]) => grant(request("PATCH", "/api/panel/keys/test%20sub", { providers, super_password: "test-secret" }),
    { params: Promise.resolve({ name: "test sub" }) });
  assert.equal((await permission(["openai-responses"])).status, 200);
  assert.equal(subGrants, "openai-responses");
  assert.equal((await permission(["not-configured"])).status, 400);
});

test("WorkBuddy pool routes cn models through the existing upstream pipeline", async () => {
  const runtime = globalThis as typeof globalThis & { prisma: Obj };
  const original = runtime.prisma;
  const fetchOriginal = globalThis.fetch;
  const state = { uid: "responses-pool-test", disabled: false, paused: false, credits: 100n, cooldownUntil: 0n, breakerUntil: 0n, degradeUntil: 0n };
  const account = { uid: state.uid, nickname: "Fixture", realm: "cn", accessToken: "fixture-pool-credential", refreshToken: "", expiresAt: 0n, domain: "",
    enterpriseId: "", deviceToken: "", state, modelCooldowns: [], modelCosts: [] };
  runtime.prisma = { ...original, account: { findMany: async () => [account], findUnique: async () => null },
    accountState: { findUnique: async () => state, upsert: async () => state },
    modelCooldown: { deleteMany: async () => ({ count: 0 }) },
    stickySession: { findUnique: async () => null, findMany: async () => [], upsert: async () => ({}), delete: async () => ({}) },
  };
  invalidateEntries();
  let sent: Obj | undefined;
  globalThis.fetch = async (target, options) => {
    const uri = new URL(String(target));
    assert.ok(uri.hostname.endsWith(".workbuddy.cn") && uri.pathname.endsWith("/chat/completions"));
    assert.match(new Headers(options?.headers).get("authorization") ?? "", /fixture-pool-credential/);
    const wire = options?.body;
    assert.ok(wire);
    sent = JSON.parse(typeof wire === "string" ? wire : gunzipSync(Buffer.from(wire as Uint8Array)).toString());
    return new Response(`data: ${chatChunk({ content: "pool reply" }, "stop")}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  };
  try {
    const result = await expectJSON(await submit({ model: "cn:qa-pool", input: "use WorkBuddy", store: false }));
    assert.equal(result.model, "cn:qa-pool");
    assert.equal(result.output[0].content[0].text, "pool reply");
    assert.equal(sent?.model, "qa-pool");
    assert.equal(sent?.messages.find((message: Obj) => message.role === "user").content, "use WorkBuddy");
  } finally {
    globalThis.fetch = fetchOriginal;
    runtime.prisma = original;
    invalidateEntries();
  }
});
