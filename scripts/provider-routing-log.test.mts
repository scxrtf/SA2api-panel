// Offline integration: real chat/provider code, fake DB/fetch. Never uses local secrets.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const requests: Record<string, any>[] = [];
const usages: Record<string, any>[] = [];
let calls = 0;
let poolReads = 0;
let provider = { name: "测试商", models: "", apiKey: "fake-upstream", baseUrl: "https://example.invalid/v1" };
let keyProviders = "测试商";
let reply: (signal?: AbortSignal | null) => Promise<Response> = async () => Response.json({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 2 } });
const oldFetch = globalThis.fetch;
const oldKey = process.env.WB2A_API_KEY;
delete process.env.WB2A_API_KEY;
(globalThis as any).prisma = {
  setting: { findUnique: async () => ({ value: JSON.stringify({ stream_idle_ms: 40, header_timeout_ms: 100 }) }) },
  apiKey: { findMany: async () => [{ name: "SA", key: "fake-client", providers: keyProviders }] },
  provider: { findUnique: async ({ where }: any) => where.name === provider.name ? provider : null },
  account: { findMany: async () => { poolReads++; throw new Error("provider must not use account pool"); } },
  requestLog: { create: async ({ data }: any) => { requests.push(data); return data; } },
  usageEvent: { create: async ({ data }: any) => { usages.push(data); return data; } },
};
globalThis.fetch = async (url, init) => {
  calls++;
  assert.equal(String(url), "https://example.invalid/v1/chat/completions");
  const body = JSON.parse(String(init?.body));
  assert.equal(body.model, "glm-5.3");
  assert.deepEqual(body.messages, [{ role: "developer", content: "keep unchanged" }]);
  assert.equal((init?.headers as any).Authorization, "Bearer fake-upstream");
  return reply(init?.signal);
};
const { handleChat, resolveModel } = await import("../src/lib/chat.ts");
const { ProviderObservation, observeProviderStream } = await import("../src/lib/provider-observation.ts");
const { streamPassthrough } = await import("../src/lib/upstream/sse.ts");
const enc = new TextEncoder();
const req = new Request("https://gateway.invalid/v1/chat/completions", {
  headers: { Authorization: "Bearer fake-client" },
});
async function chat(model = "测试商:glm-5.3", stream = false) {
  return handleChat({ body: { model, stream, messages: [{ role: "developer", content: "keep unchanged" }] },
    req, clientIP: "192.0.2.1", ua: "Test Client", path: "/v1/chat/completions", inboundHeaders: req.headers });
}
function last() { return requests.at(-1)!; }
function sse(text: string) {
  return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(text)); c.close(); } }),
    { headers: { "Content-Type": "text/event-stream" } });
}
try {
  assert.deepEqual(resolveModel("cn:glm-5.3"), { realm: "cn", provider: "", bare: "glm-5.3" });
  assert.deepEqual(resolveModel("glm-5.3"), { realm: "cn", provider: "", bare: "glm-5.3" });
  assert.deepEqual(resolveModel("测试商:model:tool"), { realm: "", provider: "测试商", bare: "model:tool" });
  let response = await chat();
  assert.equal(response.status, 200);
  assert.equal(last().model, "测试商:glm-5.3");
  assert.equal(last().provider, "测试商");
  assert.equal(last().realm, "provider:测试商");
  assert.equal(last().uid, "");
  assert.equal(last().machineId, "");
  assert.equal(last().slot, "测试商");
  assert.equal(last().keyName, "SA");
  assert.equal(last().clientIp, "192.0.2.1");
  assert.equal(last().ua, "Test Client");
  assert.equal(last().totalTokens, 10);
  assert.equal(usages.at(-1)!.uid, "测试商");
  assert.equal(usages.at(-1)!.ok, true);
  assert.equal(last().credit, undefined, "must not invent pool credit");
  console.log("PASS JSON provider route, identity, request log and usage");

  const count = calls;
  keyProviders = "*";
  response = await chat("missing:glm-5.3");
  assert.equal(response.status, 400);
  assert.equal(last().errKind, "provider_not_found");
  assert.equal(last().attempts, 0);
  assert.equal(calls, count);
  keyProviders = "other";
  response = await chat();
  assert.equal(response.status, 403);
  assert.equal(last().errKind, "provider_not_authorized");
  assert.equal(calls, count);
  keyProviders = "测试商";
  provider.models = "other-model";
  assert.equal((await chat()).status, 400);
  assert.equal(last().errKind, "model_not_allowed");
  provider.models = "";
  assert.equal((await chat("测试商:")).status, 400);
  assert.equal(calls, count);
  console.log("PASS missing/unauthorized/disabled model never falls back to pool");

  const payload = 'data:{"choices":[{"delta":{"content":"你好"},"finish_reason":"stop"}]}\r\n\r\n' +
    'data: {"usage":{"prompt_tokens":28674,"completion_tokens":17,"prompt_cache_hit_tokens":832}}\n\n' +
    'data: [DONE]';
  reply = async () => { await delay(30); return sse(payload); };
  const logsBefore = requests.length;
  response = await chat("测试商:glm-5.3", true);
  assert.equal(requests.length, logsBefore, "do not log success at response headers");
  assert.equal(await response.text(), payload, "stream must be byte-for-byte preserved");
  assert.equal(requests.length, logsBefore + 1);
  assert.equal(last().totalTokens, 28691);
  assert.equal(last().cacheHitTok, 832);
  assert.equal(last().cacheMissTok, 27842);
  assert.ok(last().ttfbMs >= 25, "TTFB includes fetch/header delay");
  assert.ok(last().durationMs >= last().ttfbMs);
  assert.equal(last().errKind, "");
  console.log("PASS SSE passthrough, trailing DONE, usage/cache and end-to-end TTFB");

  reply = async () => sse('data: {"error":{"message":"failed"}}\n\ndata: [DONE]\n\n');
  response = await chat("测试商:glm-5.3", true);
  await response.text();
  assert.equal(last().status, 200, "HTTP status remains actual header status");
  assert.equal(last().errKind, "provider_error");
  assert.equal(usages.at(-1)!.ok, false);
  reply = async () => sse("");
  await (await chat("测试商:glm-5.3", true)).text();
  assert.equal(last().errKind, "provider_empty_stream");
  reply = async () => sse('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  await (await chat("测试商:glm-5.3", true)).text();
  assert.equal(last().errKind, "provider_stream_incomplete");
  console.log("PASS HTTP 200 error/empty/truncated streams are failures");

  reply = async () => new Response('denied', { status: 429 });
  assert.equal((await chat()).status, 429);
  assert.equal(last().errKind, "provider_http_error");
  reply = async () => { throw new Error("offline test failure"); };
  assert.equal((await chat()).status, 502);
  assert.equal(last().errKind, "upstream_connect");
  reply = async () => Response.json({ error: { message: "bad request" } });
  await (await chat("测试商:glm-5.3", true)).text();
  assert.equal(last().errKind, "provider_error");
  console.log("PASS HTTP/connect/JSON error responses");

  reply = async (signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  assert.equal((await chat()).status, 504);
  assert.equal(last().errKind, "provider_header_timeout");
  const abort = new AbortController();
  const cancelledReq = new Request(req, { signal: abort.signal });
  const pending = handleChat({ body: { model: "测试商:glm-5.3", messages: [{ role: "developer", content: "keep unchanged" }] },
    req: cancelledReq, clientIP: "", ua: "", path: "/v1/chat/completions", inboundHeaders: req.headers });
  setTimeout(() => abort.abort(), 20);
  assert.equal((await pending).status, 499);
  assert.equal(last().errKind, "client_cancelled");
  console.log("PASS response-header timeout and request abort");

  // A failed audit insert must not turn a successful upstream response into a 500.
  const db = (globalThis as any).prisma;
  const saveLog = db.requestLog.create;
  db.requestLog.create = () => { throw Object.assign(new Error("test DB failure"), { code: "P2003" }); };
  reply = async () => Response.json({ choices: [] });
  const usageCount = usages.length;
  assert.equal((await chat()).status, 200);
  assert.equal(usages.length, usageCount + 1);
  db.requestLog.create = saveLog;
  console.log("PASS audit failure does not block response or other audit table");

  let cancelled = false;
  reply = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { headers: { "Content-Type": "text/event-stream" } });
  response = await chat("测试商:glm-5.3", true);
  await response.body!.cancel();
  assert.equal(cancelled, true);
  assert.equal(last().errKind, "client_cancelled");
  const beforeIdle = requests.length;
  response = await chat("测试商:glm-5.3", true);
  // Keep Node alive: production idle timers intentionally use unref().
  await Promise.all([response.text(), delay(100)]);
  assert.equal(last().errKind, "provider_stream_timeout");
  assert.equal(requests.length, beforeIdle + 1);
  console.log("PASS cancellation/idle timeout recorded once and upstream cancelled");

  reply = async () => new Response(new ReadableStream({ start(c) { c.error(new Error("broken stream")); } }),
    { headers: { "Content-Type": "text/event-stream" } });
  response = await chat("测试商:glm-5.3", true);
  await assert.rejects(response.text());
  assert.equal(last().errKind, "provider_stream_error");
  console.log("PASS stream read failure");

  // Chunk boundaries may split UTF-8 and JSON, including the final unterminated line.
  const obs = new ProviderObservation(Date.now() - 100);
  for (const byte of enc.encode(payload)) obs.chunk(Uint8Array.of(byte));
  obs.end();
  assert.equal(obs.totalTokens, 28691);
  assert.equal(obs.errKind, "");
  const delayed = new ProviderObservation(Date.now());
  let finishes = 0;
  const source = new ReadableStream<Uint8Array>({ async start(c) {
    c.enqueue(enc.encode('data: {"choices":[{"finish_reason":"stop"}]}\n\n'));
    await delay(30); c.close();
  } });
  await new Response(observeProviderStream(source, delayed, async () => { finishes++; })).text();
  assert.equal(finishes, 1);
  const upstream = sse('data: {"choices":[]}\n\ndata: [DONE]\n\n').body!;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const statsPromise = streamPassthrough(upstream, writable, null, undefined, Date.now() - 100);
  await new Response(readable).text();
  assert.ok((await statsPromise).ttfbMs >= 100, "pool TTFB includes upstream request time");
  assert.equal(poolReads, 0);
  console.log("PASS UTF-8 chunking and pool TTFB regression");

  const { GET: getLogs } = await import("../src/app/api/panel/request_logs/route.ts");
  const queries: any[] = [];
  db.requestLog.findMany = async (q: any) => { queries.push(q); return []; };
  await getLogs(new Request("https://gateway.invalid/api/panel/request_logs?outcome=ok"));
  assert.deepEqual(queries.at(-1).where, { status: { lt: 400 }, errKind: "" });
  await getLogs(new Request("https://gateway.invalid/api/panel/request_logs?outcome=error"));
  assert.deepEqual(queries.at(-1).where.OR, [{ status: { gte: 400 } }, { errKind: { not: "" } }]);
  const { POST: createProvider } = await import("../src/app/api/panel/providers/route.ts");
  for (const name of ["cn", "global"]) {
    const resp = await createProvider(new Request("https://gateway.invalid/api/panel/providers", {
      method: "POST", body: JSON.stringify({ name, base_url: "https://example.invalid", key: "fake" }),
    }));
    assert.equal(resp.status, 400);
  }
  console.log("PASS outcome filtering and reserved provider prefixes");

  const { GET: metrics } = await import("../src/app/api/panel/request_metrics/route.ts");
  db.requestLog.count = async (query: any) => { queries.push(query); return 0; };
  db.requestLog.aggregate = async () => ({ _avg: { durationMs: 0 } });
  await metrics(new Request("https://gateway.invalid/api/panel/request_metrics"));
  assert.deepEqual(queries.at(-1).where.OR, [{ status: { gte: 400 } }, { errKind: { not: "" } }]);
  console.log("PASS dashboard error count includes HTTP 200 errors");
} finally {
  globalThis.fetch = oldFetch;
  if (oldKey === undefined) delete process.env.WB2A_API_KEY;
  else process.env.WB2A_API_KEY = oldKey;
  delete (globalThis as any).prisma;
}
