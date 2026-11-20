import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { requestLogSessionId } from "../src/lib/request-log-session-id";
import { summarizeRequestSessions, type RequestLogSession } from "../src/lib/request-log-sessions";

test("only explicit session identifiers correlate request logs, scoped by gateway key", () => {
  const id = requestLogSessionId(new Headers({ "x-wb2a-session-id": "thread-a" }), { model: "gpt-5" }, "primary");
  assert.match(id ?? "", /^[0-9a-f]{32}$/);
  assert.equal(requestLogSessionId(new Headers(), { metadata: { conversationId: "thread-a" }, model: "claude" }, "primary"), id);
  assert.equal(requestLogSessionId(new Headers({ "x-codex-turn-metadata": '{"thread_id":"thread-a","turn_id":"turn-z"}', session_id: "other" }), {}, "primary"), id);
  assert.equal(requestLogSessionId(new Headers(), { metadata: { user_id: '{"session_id":"thread-a"}' } }, "primary"), id);
  const uuid = "a1c1489a-1540-4e7c-90d5-e03505a319a4";
  assert.equal(requestLogSessionId(new Headers(), { metadata: { user_id: `user_device_account__session_${uuid}` } }, "primary"),
    requestLogSessionId(new Headers({ "x-session-id": uuid }), {}, "primary"));
  assert.notEqual(requestLogSessionId(new Headers({ "X-Conversation-ID": "thread-a" }), {}, "secondary"), id);
  assert.notEqual(requestLogSessionId(new Headers({ "X-Conversation-ID": "thread-b" }), {}, "primary"), id);
  assert.equal(requestLogSessionId(new Headers({ "x-conversation-request-id": "thread-a", "x-session-id": "a".repeat(257) }), {
    metadata: { user_id: "user-thread-a" }, prompt_cache_key: "thread-a", messages: [{ role: "user", content: "same text" }],
  }, "primary"), undefined);
});

const sessionId = requestLogSessionId(new Headers(), { conversation_id: "shared-thread" }, "fixture")!;
const lastAt = "2026-11-20T01:10:00.000Z";
const group: RequestLogSession = {
  id: "s:" + sessionId, lastAt, model: "model-a", modelCount: 2, keyName: "fixture",
  count: 80, failed: 2, reported: 4, cacheHitTok: 100, cacheMissTok: 1_900,
};

test("page statistics are weighted across all matching members, not per-session averages", () => {
  assert.deepEqual(summarizeRequestSessions([]), { count: 0, failed: 0, reported: 0, rate: null });
  assert.deepEqual(summarizeRequestSessions([group, { ...group,
    id: "r:legacy-a", count: 1, failed: 0, reported: 1, cacheHitTok: 500, cacheMissTok: 0,
  }]), { count: 81, failed: 2, reported: 5, rate: 0.24 });
});

test("CloudBase and Prisma ship the same additive session migration", () => {
  const prisma = readFileSync(new URL("../prisma/migrations/20261120120000_request_log_sessions/migration.sql", import.meta.url), "utf8");
  const cloudbase = readFileSync(new URL("../cloudbase/migrations/20261120120000_request_log_sessions.sql", import.meta.url), "utf8");
  assert.equal(cloudbase.replace(/\r\n/g, "\n"), prisma.replace(/\r\n/g, "\n"));
});

test("session API keeps the existing auth, preserves filter scope and only fetches member-page summaries", async (t) => {
  const oldDb = (globalThis as { prisma?: unknown }).prisma;
  const originalUseRest = process.env.USE_CLOUDBASE_REST;
  const originalKey = process.env.WB2A_API_KEY;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    (globalThis as { prisma?: unknown }).prisma = oldDb;
    if (originalUseRest === undefined) delete process.env.USE_CLOUDBASE_REST; else process.env.USE_CLOUDBASE_REST = originalUseRest;
    if (originalKey === undefined) delete process.env.WB2A_API_KEY; else process.env.WB2A_API_KEY = originalKey;
    globalThis.fetch = originalFetch;
  });
  process.env.USE_CLOUDBASE_REST = "0";
  process.env.WB2A_API_KEY = "session-panel-fixture";
  const queries: unknown[][] = [];
  const memberQueries: { where: unknown; select: Record<string, boolean> }[] = [];
  const writes: Record<string, unknown>[] = [];
  let writeError: unknown = null;
  (globalThis as { prisma?: unknown }).prisma = {
    setting: { findUnique: async () => null },
    $queryRaw: async (strings: TemplateStringsArray, ...args: unknown[]) => {
      assert.match(strings.join(""), /public\.wb2_request_log_session_page/);
      queries.push(args);
      const [, , , , , groupId] = args;
      return [{ result: groupId ? { total: 80, entries: ["request-51"] } : { total: 101, entries: [group] } }];
    },
    requestLog: {
      findMany: async (args: { where: unknown; select: Record<string, boolean> }) => {
        memberQueries.push(args);
        return [{ id: "request-51", errMsg: "x".repeat(700) }];
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        if (writeError && data.sessionId) throw writeError;
        return { id: "saved" };
      },
    },
  };
  const { GET } = await import("../src/app/api/panel/request_logs/route");
  const { createRequestLog } = await import("../src/lib/request-log-write");
  const endpoint = "http://localhost/api/panel/request_logs?";
  const read = (q: string) => GET(new Request(endpoint + q, { headers: { Authorization: "Bearer session-panel-fixture" } }));
  assert.equal((await GET(new Request(endpoint + "view=sessions"))).status, 401);
  assert.equal((await read("group=s:invalid")).status, 400);
  assert.equal(queries.length, 0);

  const filters = "model=gpt&outcome=error&err=limit&client_ip=192.0.2&from=2026-11-01T00:00:00Z&to=2026-11-20T01:10:00Z";
  const response = await read("view=sessions&page=2&limit=1000&" + filters);
  assert.equal(response.status, 200);
  const summary = await response.json();
  assert.deepEqual(summary.entries, [group]);
  assert.equal(summary.totalPages, 2);
  assert.deepEqual(summary.scope, { from: "2026-11-01T00:00:00.000Z", to: lastAt });
  assert.deepEqual(queries[0], [JSON.stringify({ account: "", model: "gpt", client_ip: "192.0.2", user_agent: "", key: "", err: "limit", outcome: "error" }), summary.scope.from, lastAt, 100, 100, null]);
  assert.equal(memberQueries.length, 0);

  const members = await (await read("group=" + encodeURIComponent(group.id) + "&page=2&limit=50&" + filters)).json();
  assert.deepEqual(queries[1], [...queries[0].slice(0, 3), 50, 50, group.id]);
  assert.deepEqual(memberQueries[0].where, { id: { in: ["request-51"] } });
  for (const field of ["requestMessages", "responseMessage", "attemptDetails", "parameterOverrides", "errorDetail"]) {
    assert.equal(memberQueries[0].select[field], undefined);
  }
  assert.equal(members.totalPages, 2);
  assert.equal(members.entries[0].errMsg, "x".repeat(512) + "…（详情页看全文）");

  assert.deepEqual(await createRequestLog({ model: "gpt", sessionId }), { id: "saved" });
  assert.equal(writes[0].sessionId, sessionId);
  writeError = Object.assign(new Error("Missing RequestLog.sessionId"), { code: "P2022" });
  assert.deepEqual(await createRequestLog({ model: "legacy\0", sessionId }), { id: "saved" });
  assert.deepEqual(writes.slice(1), [{ model: "legacy", sessionId }, { model: "legacy" }]);
  writeError = Object.assign(new Error("Missing another column"), { code: "P2022" });
  await assert.rejects(createRequestLog({ model: "gpt", sessionId }), /another column/);
  assert.equal(writes.length, 4);

  process.env.USE_CLOUDBASE_REST = "1";
  const params: Record<string, unknown>[] = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(String(url)).pathname, "/rpc/wb2_request_log_session_page");
    assert.equal(init?.method, "POST");
    params.push(JSON.parse(String(init?.body)));
    return Response.json({ total: 1, entries: [group] });
  };
  const rest = await (await read("view=sessions&" + filters)).json();
  assert.deepEqual(rest.entries, [group]);
  assert.deepEqual(params[0], { p_filters: JSON.parse(String(queries[0][0])), p_from: summary.scope.from, p_to: lastAt, p_limit: 50, p_offset: 0, p_group: null, p_storage_zone: "Asia/Shanghai" });
  globalThis.fetch = async () => new Response("internal connection details", { status: 500 });
  const failed = await read("view=sessions");
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /internal connection details/);
});

test("chat and translated Messages log the same client session across provider and error paths", async (t) => {
  const db = globalThis as typeof globalThis & { prisma?: unknown };
  const previousDb = db.prisma;
  const previousFetch = globalThis.fetch;
  const config = { WB2A_API_KEY: "session-main-key", USE_CLOUDBASE_REST: "0", WB2_WORKSPACE_CAPTURE: "0" };
  const previous = Object.fromEntries(Object.keys(config).map((name) => [name, process.env[name]]));
  t.after(() => {
    db.prisma = previousDb;
    globalThis.fetch = previousFetch;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  Object.assign(process.env, config);
  const rows: Record<string, unknown>[] = [];
  db.prisma = {
    setting: { findUnique: async () => null },
    apiKey: { findMany: async () => [{ name: "fixture", key: "session-child-key", providers: "fixture-provider" }] },
    provider: { findMany: async () => [{ name: "fixture-provider", baseUrl: "https://session-provider.invalid/v1", apiKey: "fake", models: "" }] },
    requestLog: { create: async ({ data }: { data: Record<string, unknown> }) => { rows.push(data); return { id: String(rows.length) }; }, count: async () => 0 },
    usageEvent: { create: async () => ({}) },
  };
  globalThis.fetch = async (_url, init) => {
    const sent = JSON.parse(String(init?.body));
    assert.equal("sessionId" in sent, false, "log correlation stays out of the provider body");
    return Response.json({ id: "response-fixture", model: sent.model, choices: [{ message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }] });
  };
  const { getConfig } = await import("../src/lib/config");
  await getConfig(true);
  const { POST: chat } = await import("../src/app/api/v1/chat/completions/route");
  const { POST: messages } = await import("../src/app/api/v1/messages/route");
  const request = (route: string, model: string, headers: Record<string, string>, metadata?: Record<string, string>) => new Request("http://localhost/api/v1/" + route, {
    method: "POST", headers: { Authorization: "Bearer session-child-key", "content-type": "application/json", ...headers },
    body: JSON.stringify({ model, max_tokens: 20, messages: [{ role: "user", content: "Test" }], metadata }),
  });
  assert.equal((await chat(request("chat/completions", "fixture-provider:model-a", { "x-conversation-id": "shared-thread" }))).status, 200);
  assert.equal((await messages(request("messages", "fixture-provider:model-b", {}, { user_id: '{"session_id":"shared-thread"}' }))).status, 200);
  assert.equal((await chat(request("chat/completions", "not-authorized:model-a", { "x-conversation-id": "shared-thread" }))).status, 403);
  assert.deepEqual(rows.map((row) => [row.path, row.status, row.sessionId]), [
    ["/v1/chat/completions", 200, sessionId], ["/v1/messages", 200, sessionId], ["/v1/chat/completions", 403, sessionId],
  ]);
});
