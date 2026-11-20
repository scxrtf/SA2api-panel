import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { DEFAULT_CONFIG } from "../src/lib/config.ts";
import { clientVersion, type AuthShape } from "../src/lib/upstream/client.ts";
import { UpstreamError } from "../src/lib/upstream/errors.ts";
import {
  agentToolHeaders, buildWebFetchBody, buildWebSearchBody, WEB_SEARCH_FRESHNESS,
  WEB_SEARCH_TIMEOUT_MS, webFetch, webSearch,
} from "../src/lib/upstream/agenttool.ts";

const auth: AuthShape = {
  uid: "offline-tool", nickname: "", realm: "cn", accessToken: "offline-token",
  refreshToken: "", expiresAt: 0, domain: "", enterpriseId: "", deviceToken: "",
};
type Sent = { url: string; init: RequestInit; body: Record<string, unknown> };
const sent: Sent[] = [];
const originalFetch = globalThis.fetch;
let reply: (request: Sent) => Promise<Response> = async ({ url }) => new Response(url.endsWith("/search")
  ? '{ "results": [], "total_results": 0 }'
  : '{ "content": "# offline", "title": "Fixture" }');
globalThis.fetch = async (input, init = {}) => {
  const request = { url: String(input), init, body: JSON.parse(String(init.body)) as Record<string, unknown> };
  sent.push(request);
  return reply(request);
};
test.after(() => { globalThis.fetch = originalFetch; });

const routing = await import("../src/lib/agenttool-route.ts");
let allowed = true;
mock.module(new URL("../src/lib/auth-guard.ts", import.meta.url).href, {
  namedExports: { verifyAny: async () => allowed },
});
mock.module(new URL("../src/lib/agenttool-route.ts", import.meta.url).href, {
  namedExports: {
    ...routing,
    runAgentTool: async (realm: string, call: (cfg: typeof DEFAULT_CONFIG, account: AuthShape) => Promise<string>) => ({
      status: 200, code: "", msg: "", data: await call(DEFAULT_CONFIG, { ...auth, realm }),
    }),
  },
});
const { POST: searchPOST } = await import("../src/app/api/v1/search/route.ts");
const { POST: fetchPOST } = await import("../src/app/api/v1/fetch/route.ts");
function request(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://gateway.invalid/api/v1/" + path, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}

test("真实工具头独立于 chat；CLI UA、空会话、v7 双 ID 与字段集合对齐", () => {
  const headers = agentToolHeaders(DEFAULT_CONFIG, auth, "search");
  assert.deepEqual(Object.keys(headers), [
    "Accept", "Content-Type", "X-Requested-With", "User-Agent", "Authorization",
    "X-Agent-Intent", "X-Agent-Runtime", "X-Conversation-ID", "X-Conversation-Request-ID",
    "X-Conversation-Message-ID", "X-Request-ID", "X-Product", "X-IDE-Type", "X-IDE-Name",
    "X-IDE-Version", "X-User-Id", "X-Department-Info",
  ]);
  assert.equal(headers["User-Agent"], "CLI/" + clientVersion(DEFAULT_CONFIG, auth));
  assert.equal(headers["Content-Type"], "application/json;charset=UTF-8");
  assert.equal(headers["X-Conversation-ID"], "");
  assert.equal(headers["X-Conversation-Request-ID"], "");
  assert.match(headers["X-Request-ID"], /^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
  assert.equal(headers["X-Request-ID"], headers["X-Conversation-Message-ID"]);
  for (const name of ["X-Private-Data", "X-Domain", "X-Agent-Purpose", "baggage", "traceparent", "X-Stainless-Lang", "X-Root-Request-ID"]) {
    assert.equal(headers[name], undefined);
  }
});

test("WebFetch 额外携带 X-Wb-Uid；会话上下文与显式配置不会误套 RPC UA", () => {
  const cfg = { ...DEFAULT_CONFIG, client_version: "9.8.7", client_name: "FixtureIDE" };
  const headers = agentToolHeaders(cfg, auth, "webfetch", {
    conversationID: "session-id", conversationRequestID: "turn-id", agentIntent: "plan",
    agentRuntime: "cloud-agent", departmentInfo: "test-department",
  });
  assert.equal(headers["User-Agent"], "CLI/9.8.7");
  assert.equal(headers["X-Wb-Uid"], auth.uid);
  assert.equal(headers["X-Agent-Intent"], "craft");
  assert.equal(headers["X-Agent-Runtime"], "cloud-agent");
  assert.equal(headers["X-Conversation-ID"], "session-id");
  assert.equal(headers["X-Conversation-Request-ID"], "turn-id");
  assert.equal(headers["X-Department-Info"], "test-department");
  assert.equal(headers["X-IDE-Type"], "FixtureIDE");
  assert.equal(agentToolHeaders({ ...cfg, user_agent: "Explicit-UA" }, auth, "search")["User-Agent"], "Explicit-UA");
});

test("搜索默认5条；允许域直传、屏蔽域按真机追加 -site 查询，freshness 原样保留", () => {
  assert.deepEqual(buildWebSearchBody("offline"), { query: "offline", type: "text2text", max_results: 5 });
  assert.deepEqual(buildWebSearchBody("offline", 9, {
    allowed_domains: ["example.com"], blocked_domains: ["blocked.test", "another.test"], freshness: "m12",
  }), {
    query: "offline (-site:blocked.test -site:another.test)", type: "text2text", max_results: 9,
    allowed_domains: ["example.com"], freshness: "m12",
  });
  assert.deepEqual(buildWebSearchBody("offline", 0, { allowed_domains: [], blocked_domains: [] }), {
    query: "offline", type: "text2text", max_results: 5,
  });
  for (const value of ["d", "d1", "d30", "m", "m12", "y", "y5"]) assert.ok(WEB_SEARCH_FRESHNESS.test(value));
  for (const value of ["", "d0", "d31", "m13", "y6", "D1", " d1"]) assert.equal(WEB_SEARCH_FRESHNESS.test(value), false);
});

test("WebFetch 请求完整默认字段与可选 model_name/prompt 不再丢失", () => {
  assert.deepEqual(buildWebFetchBody("https://example.invalid"), {
    url: "https://example.invalid", format: "markdown", prompt: "", timeout: 20, max_length: 100_000,
  });
  assert.deepEqual(buildWebFetchBody("https://example.invalid", {
    prompt: "extract dates", model_name: "fixture-model", timeout: 7, max_length: 512,
  }), {
    url: "https://example.invalid", format: "markdown", prompt: "extract dates",
    timeout: 7, max_length: 512, model_name: "fixture-model",
  });
});

test("真实调用走 native fetch，保持成功原文字节并使用全局账号域名", async () => {
  const raw = '  { "content": "fixture", "title": "Fixture" }\n';
  const previous = reply;
  reply = async () => new Response(raw);
  try {
    assert.equal(await webFetch(DEFAULT_CONFIG, { ...auth, realm: "global" }, "https://example.invalid"), raw);
    assert.equal(sent.at(-1)?.url, "https://www.workbuddy.ai/agenttool/v1/webfetch");
    assert.deepEqual(sent.at(-1)?.body, buildWebFetchBody("https://example.invalid"));
    assert.equal((sent.at(-1)?.init.headers as Record<string, string>)["X-Wb-Uid"], auth.uid);
  } finally { reply = previous; }
});

test("搜索路由保留显式 max_results/count 与完整筛选参数，默认不改成调用者值以外的数量", async () => {
  const response = await searchPOST(request("search", {
    query: "offline", count: 8, allowed_domains: ["example.com"], blocked_domains: ["blocked.test"], freshness: "d7",
  }, { "X-Conversation-ID": "session", "X-Conversation-Request-ID": "turn", "X-Agent-Intent": "plan" }));
  assert.equal(response.status, 200);
  assert.deepEqual(sent.at(-1)?.body, {
    query: "offline (-site:blocked.test)", type: "text2text", max_results: 8,
    allowed_domains: ["example.com"], freshness: "d7",
  });
  const headers = sent.at(-1)?.init.headers as Record<string, string>;
  assert.equal(headers["X-Conversation-ID"], "session");
  assert.equal(headers["X-Conversation-Request-ID"], "turn");
  assert.equal(headers["X-Agent-Intent"], "plan");
  await searchPOST(request("search", { query: "offline", max_results: 7, count: 8 }));
  assert.equal(sent.at(-1)?.body.max_results, 7);
  await searchPOST(request("search", { query: "offline", max_results: 0, count: 9 }, { "User-Agent": "deepseek-harness" }));
  assert.equal(sent.at(-1)?.body.max_results, 9);
  await searchPOST(request("search", { query: "offline" }));
  assert.equal(sent.at(-1)?.body.max_results, 5);
  await searchPOST(request("search", { query: "  offline  " }));
  assert.equal(sent.at(-1)?.body.query, "  offline  ");
});

test("Agent HTTP错误的鉴权/限流/客户端分类与 Retry-After 不回归", async () => {
  const previous = reply;
  try {
    for (const fixture of [
      { status: 401, body: "<html><title>401 Authorization Required</title></html>", kind: "auth_expired", retry: 0 },
      { status: 429, body: "Too Many Requests", kind: "soft_rate", retry: 2000 },
      { status: 400, body: '{"code":15003,"msg":"bad tool request"}', kind: "client", retry: 0 },
    ]) {
      reply = async () => new Response(fixture.body, { status: fixture.status, headers: fixture.retry ? { "Retry-After": "2" } : {} });
      await assert.rejects(webSearch(DEFAULT_CONFIG, auth, "offline", 5), (error: unknown) => {
        assert.ok(error instanceof UpstreamError);
        assert.equal(error.kind, fixture.kind);
        assert.equal(error.status, fixture.status);
        assert.equal(error.retryAfterMs, fixture.retry);
        return true;
      });
    }
  } finally { reply = previous; }
});

test("Fetch 路由映射选中模型及可选参数，并保留本地 DSH 响应兼容包装", async () => {
  const response = await fetchPOST(request("fetch", {
    url: "https://example.invalid/page", prompt: "extract dates", model: "global:fixture-model",
    timeout: 7, max_length: 512,
  }));
  assert.equal(response.status, 200);
  assert.equal(sent.at(-1)?.url, "https://www.workbuddy.ai/agenttool/v1/webfetch");
  assert.deepEqual(sent.at(-1)?.body, {
    url: "https://example.invalid/page", format: "markdown", prompt: "extract dates",
    timeout: 7, max_length: 512, model_name: "fixture-model",
  });
  assert.deepEqual(await response.json(), { content: "# offline", title: "Fixture", url: "https://example.invalid/page" });
  await fetchPOST(request("fetch", { url: "https://example.invalid", model: "cn:routing-only", model_name: "chosen" }));
  assert.equal(sent.at(-1)?.body.model_name, "chosen");
});

test("工具已知参数的非法类型/范围在取号和上游请求前返回400", async () => {
  const invalidSearch = [null, [], { query: "x" }, { query: "offline", max_results: -1 },
    { query: "offline", max_results: 1.5 }, { query: "offline", count: "5" },
    { query: "offline", count: Number.MAX_SAFE_INTEGER + 1 }, { query: "offline", allowed_domains: "example.com" },
    { query: "offline", blocked_domains: [1] }, { query: "offline", freshness: "d31" },
    { query: "offline", model: {} }, { query: "offline", realm: "invalid" }, { query: "offline", deep: "true" }];
  const invalidFetch = [null, [], { url: "file:///etc/passwd" }, { url: "https://example.invalid", prompt: 1 },
    { url: "https://example.invalid", timeout: 0 }, { url: "https://example.invalid", timeout: 121 },
    { url: "https://example.invalid", max_length: 0 }, { url: "https://example.invalid", max_length: 1_000_001 },
    { url: "https://example.invalid", max_length: 1.5 }, { url: "https://example.invalid", model_name: "" },
    { url: "https://example.invalid", format: "html" }];
  const before = sent.length;
  for (const body of invalidSearch) assert.equal((await searchPOST(request("search", body))).status, 400);
  for (const body of invalidFetch) assert.equal((await fetchPOST(request("fetch", body))).status, 400);
  assert.equal(sent.length, before);
});

test("工具路由仍先鉴权，预中止不会发出 native fetch", async () => {
  const before = sent.length;
  allowed = false;
  try { assert.equal((await searchPOST(request("search", { query: "offline" }))).status, 401); }
  finally { allowed = true; }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(webSearch(DEFAULT_CONFIG, auth, "offline", 5, controller.signal));
  assert.equal(sent.length, before);
});

test("默认20秒 native fetch deadline 确实传播取消而非120秒旧值", async (t) => {
  assert.equal(WEB_SEARCH_TIMEOUT_MS, 20_000);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  t.after(() => t.mock.timers.reset());
  const previous = reply;
  let reached: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => { reached = resolve; });
  reply = async ({ init }) => new Promise<Response>((_resolve, reject) => {
    reached();
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
  try {
    const pending = webSearch(DEFAULT_CONFIG, auth, "offline", 5);
    const rejection = assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "TimeoutError");
    await waiting;
    t.mock.timers.tick(20_000);
    await rejection;
  } finally { reply = previous; }
});
