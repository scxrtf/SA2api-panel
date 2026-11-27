import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { DEFAULT_CONFIG, type AppConfig } from "../src/lib/config.ts";

type Outbound = { url: URL; init: RequestInit };
type LoginSession = { state: string; realm: string; expiresAt: bigint; createdAt: Date; verifyUrl?: string };
const calls: Outbound[] = [];
const responses: Response[] = [];
const sessions = new Map<string, LoginSession>();
const accounts = new Map<string, Record<string, unknown>>();
const writes: Array<{ create: Record<string, unknown>; update: Record<string, unknown> }> = [];
let cfg: AppConfig = { ...DEFAULT_CONFIG };
const originalFetch = globalThis.fetch;
const fakeRequest = async (input: string | URL | Request, init: RequestInit = {}) => {
  init.signal?.throwIfAborted();
  calls.push({ url: new URL(input instanceof Request ? input.url : String(input)), init });
  const next = responses.shift();
  assert.ok(next, "unexpected upstream call in offline login test");
  return next;
};
if (process.env.WB2API_OFFLINE_TEST === "1") {
  // The suite already redirects officialEgress to this process's fetch fixture.
  globalThis.fetch = fakeRequest;
} else {
  mock.module(new URL("../src/lib/upstream/official-egress.ts", import.meta.url).href, {
    namedExports: { officialEgress: fakeRequest, closeOfficialEgressConnections() {} },
  });
}
test.after(() => { globalThis.fetch = originalFetch; });
const actualClient = await import("../src/lib/upstream/client.ts");
mock.module(new URL("../src/lib/upstream/client.ts", import.meta.url).href, {
  namedExports: {
    ...actualClient,
    dailyCheckin: async () => {}, claimTrial: async () => true,
    userResource: async () => ({ remain: 100, total: 100, expiring: 0, earliestAt: 0, earliestRemain: 0 }),
  },
});
mock.module(new URL("../src/lib/config.ts", import.meta.url).href, {
  namedExports: { DEFAULT_CONFIG, getConfig: async () => cfg },
});
mock.module(new URL("../src/lib/panel-auth.ts", import.meta.url).href, {
  namedExports: {
    ok: (data: Record<string, unknown> = {}) => Response.json({ ok: true, ...data }),
    fail: (status: number, error: string) => Response.json({ ok: false, error }, { status }),
  },
});
mock.module(new URL("../src/lib/db.ts", import.meta.url).href, {
  namedExports: { prisma: {
    loginSession: {
      deleteMany: async () => ({ count: 0 }),
      upsert: async ({ create, update }: { create: LoginSession; update: Partial<LoginSession> }) => {
        const previous = sessions.get(create.state);
        const row = previous ? { ...previous, ...update } : { createdAt: new Date(), ...create };
        sessions.set(row.state, row); return row;
      },
      findUnique: async ({ where }: { where: { state: string } }) => sessions.get(where.state) ?? null,
      update: async () => ({}),
      delete: async ({ where }: { where: { state: string } }) => sessions.delete(where.state),
    },
    account: { upsert: async (args: { where: { uid: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
      writes.push(args);
      const saved = accounts.has(args.where.uid) ? { ...accounts.get(args.where.uid), ...args.update } : args.create;
      accounts.set(args.where.uid, saved); return saved;
    } },
  } },
});
mock.module(new URL("../src/lib/pool.ts", import.meta.url).href, {
  namedExports: { revive: async () => {}, markCheckin: async () => {}, setCreditsDetailed: async () => {} },
});
mock.module(new URL("../src/lib/upstream/global_register.ts", import.meta.url).href, {
  namedExports: { globalCompleteRegistration: async () => true },
});
mock.module(new URL("../src/lib/runlog.ts", import.meta.url).href, { namedExports: { runlogAccount() {} } });
mock.module(new URL("../src/lib/machine-key.ts", import.meta.url).href, {
  namedExports: { getOrCreateMachineId: async () => ({ id: "test-machine" }), authorizeMachineForAccount: async () => {} },
});
const { loginEndpoints, loginHeaders, loginDoJSON, alignLoginAuthURL, LoginUpstreamError } = await import("../src/lib/login.ts");
const start = await import("../src/app/api/panel/login/start/route.ts");
const poll = await import("../src/app/api/panel/login/poll/route.ts");
const envelope = (data: unknown, code = 0) => Response.json({ code, data });
const startRequest = (realm = "cn") => new Request("http://localhost/api/panel/login/start", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ realm }),
});
const pollRequest = (state = "test-state") => new Request("http://localhost/api/panel/login/poll?state=" + encodeURIComponent(state));
const putSession = (realm = "cn", state = "test-state", expiresAt = Date.now() + 900_000) =>
  sessions.set(state, { state, realm, expiresAt: BigInt(expiresAt), createdAt: new Date() });
const headers = (call: Outbound) => new Headers(call.init.headers);

test.beforeEach(() => {
  calls.length = 0; responses.length = 0; sessions.clear(); accounts.clear(); writes.length = 0;
  cfg = { ...DEFAULT_CONFIG };
});

test("登录端点按站点采用注册的 WorkBuddy platform 与 AccountScoped /account", () => {
  for (const realm of ["cn", "global"]) {
    const ep = loginEndpoints(realm);
    const host = realm === "global" ? "https://www.workbuddy.ai" : "https://www.workbuddy.cn";
    const platform = realm === "global" ? "workbuddy-ai" : "workbuddy";
    assert.equal(ep.state, host + "/v2/plugin/auth/state?platform=" + platform);
    assert.equal(ep.token, host + "/v2/plugin/auth/token?state=");
    assert.equal(ep.account, host + "/v2/plugin/account");
    assert.equal(ep.origin, host);
  }
});

test("登录头使用 RPC UA、匿名哨兵及 UUIDv4，不带浏览器或聊天 SDK 头", () => {
  const ep = loginEndpoints("cn");
  for (const [url, body] of [[ep.state, "{}"], [ep.token + "state", null]] as const) {
    const h = loginHeaders(url, "must-not-leak", body, ep.origin);
    assert.equal(h["User-Agent"], "WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0");
    assert.equal(h.Accept, "application/json, text/plain, */*");
    assert.equal(h["Accept-Encoding"], "gzip, compress, deflate, br");
    for (const name of ["X-No-Authorization", "X-No-User-Id", "X-No-Enterprise-Id", "X-No-Department-Info"]) assert.equal(h[name], "true");
    for (const name of ["Authorization", "Origin", "Referer", "X-Requested-With", "X-Agent-Intent", "X-Stainless-Lang"]) assert.equal(h[name], undefined);
    assert.match(h["X-Request-ID"], /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
    assert.equal(h["Content-Type"], body === null ? undefined : "application/json");
    assert.equal(h["X-Domain"], body === null ? undefined : "www.workbuddy.cn");
  }
  const account = loginHeaders(ep.account, "test-bearer", null, ep.origin, cfg, { domain: "copilot.tencent.com" });
  assert.equal(account.Authorization, "Bearer test-bearer");
  assert.equal(account["X-Domain"], "copilot.tencent.com");
  assert.equal(account["X-No-Authorization"], undefined);
});

test("登录 URL 仅在原生三个可信 CN origin 间对齐", () => {
  assert.equal(alignLoginAuthURL("https://copilot.tencent.com/login?state=abc", "https://www.workbuddy.cn"), "https://www.workbuddy.cn/login?state=abc");
  // 原生直接赋 URL.host；目标未写端口时 WHATWG URL 保留源的显式端口。
  assert.equal(alignLoginAuthURL("http://copilot.tencent.com:8080/login?state=abc", "https://www.workbuddy.cn"), "https://www.workbuddy.cn:8080/login?state=abc");
  assert.equal(alignLoginAuthURL("https://third-party.invalid/login", "https://www.workbuddy.cn"), "https://third-party.invalid/login");
  assert.equal(alignLoginAuthURL("https://www.codebuddy.ai/login", "https://www.workbuddy.ai"), "https://www.codebuddy.ai/login");
});

test("CN state→token→account 离线闭环，state 编码且保留无关账号", async () => {
  const state = "state/a &b?=x";
  accounts.set("untouched", { uid: "untouched", refreshToken: "unchanged" });
  cfg.user_agent = "ConfiguredAuthProfile/9";
  responses.push(envelope({ state, authUrl: "https://copilot.tencent.com/login?state=abc" }));
  const begun = await start.POST(startRequest());
  assert.equal(begun.status, 200);
  assert.equal((await begun.json()).url, "https://www.workbuddy.cn/login?state=abc");
  assert.ok(Number(sessions.get(state)?.expiresAt) > Date.now());
  responses.push(envelope({ accessToken: "offline-at", refreshToken: "offline-rt", expiresIn: 3600, domain: "copilot.tencent.com" }),
    envelope({ uid: "new-user", nickname: "Offline", enterpriseId: "" }));
  const response = await poll.GET(pollRequest(state));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).done, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].init.method, "POST"); assert.equal(calls[0].init.body, "{}");
  assert.equal(calls[0].url.searchParams.get("platform"), "workbuddy");
  assert.equal(calls[1].init.method, "GET"); assert.equal(calls[1].url.searchParams.get("state"), state);
  assert.equal(calls[1].url.searchParams.size, 1);
  assert.equal(calls[1].init.body, undefined);
  assert.equal(calls[2].url.pathname, "/v2/plugin/account"); assert.equal(calls[2].url.search, "");
  assert.equal(headers(calls[2]).get("authorization"), "Bearer offline-at");
  assert.equal(headers(calls[2]).get("x-domain"), "copilot.tencent.com");
  assert.ok(calls.every((call) => headers(call).get("user-agent") === "ConfiguredAuthProfile/9"));
  assert.equal(writes.length, 1);
  assert.deepEqual(accounts.get("untouched"), { uid: "untouched", refreshToken: "unchanged" });
  assert.equal(accounts.get("new-user")?.realm, "cn");
  assert.equal(sessions.has(state), false);
});

test("只有原生 pending 业务码保持等待，其余登录错误返回 502", async () => {
  putSession(); responses.push(envelope(null, 11217));
  let response = await poll.GET(pollRequest());
  assert.equal(response.status, 200); assert.equal((await response.json()).done, false);
  responses.push(envelope({ accessToken: "offline-at" }), envelope(null, 12151));
  response = await poll.GET(pollRequest());
  assert.equal(response.status, 200); assert.equal((await response.json()).done, false);
  responses.push(envelope(null, 12153));
  response = await poll.GET(pollRequest());
  assert.equal(response.status, 502);
  responses.push(new Response("service unavailable", { status: 503 }));
  assert.equal((await poll.GET(pollRequest())).status, 502);
  responses.push(envelope({ accessToken: "" }));
  assert.equal((await poll.GET(pollRequest())).status, 502, "code=0 without a usable token is not pending");
  assert.equal(writes.length, 0);
});

test("过期登录会话在本地结束，不继续发上游请求", async () => {
  putSession("cn", "test-state", Date.now() - 1);
  assert.equal((await poll.GET(pollRequest())).status, 404);
  assert.equal(calls.length, 0);
});

test("Global 使用 workbuddy-ai 客户端并采用配置 UA，支持原生绝对毫秒过期时间", async () => {
  putSession("global");
  const expiresAt = Date.now() + 3_600_000;
  responses.push(envelope({ state: "global-state", authUrl: "https://www.workbuddy.ai/login?platform=workbuddy-ai&state=global-state" }));
  const begun = await start.POST(startRequest("global"));
  assert.equal(begun.status, 200);
  assert.equal((await begun.json()).url, "https://www.workbuddy.ai/login?platform=workbuddy-ai&state=global-state");
  assert.equal(calls[0].url.searchParams.get("platform"), "workbuddy-ai");
  responses.push(envelope({ accessToken: "offline-global", expiresAt, domain: "www.codebuddy.ai" }),
    envelope({ uid: "global-user", nickname: "Global" }));
  const response = await poll.GET(pollRequest());
  assert.equal(response.status, 200);
  assert.ok(calls.every((call) => call.url.origin === "https://www.workbuddy.ai"));
  assert.equal(headers(calls[1]).get("user-agent"), "workbuddy-ai/5.9.4 workbuddy-ai/5.9.4 CLI/2.165.0");
  assert.equal(writes[0].create.expiresAt, BigInt(Math.floor(expiresAt / 1000)));
  assert.equal(writes[0].create.realm, "global");
});

test("loginDoJSON 保留五参签名，HTTP/业务错误包含可辨认状态", async () => {
  const ep = loginEndpoints("cn");
  responses.push(envelope({ state: "compat" }));
  assert.deepEqual(await loginDoJSON("POST", ep.state, "", "{}", ep.origin), { state: "compat" });
  responses.push(Response.json({ code: 12151 }, { status: 403 }));
  await assert.rejects(loginDoJSON("GET", ep.account, "token", null, ep.origin),
    (error: unknown) => error instanceof LoginUpstreamError && error.code === 12151 && error.status === 403);
  responses.push(Response.json(null));
  await assert.rejects(loginDoJSON("GET", ep.token + "state", "", null, ep.origin), /parse failed/);
});

test("无载荷 POST 明确写出空 body，GET 保持无 body 与 Content-Type", async () => {
  const ep = loginEndpoints("cn");
  responses.push(envelope({}));
  await loginDoJSON("POST", ep.state, "", null, ep.origin);
  assert.equal(calls[0].init.body, "", "raw transport uses empty string to emit Content-Length:0");
  assert.equal(headers(calls[0]).get("content-type"), "application/x-www-form-urlencoded");
  responses.push(envelope({}));
  await loginDoJSON("GET", ep.token + "state", "", null, ep.origin);
  assert.equal(calls[1].init.body, undefined);
  assert.equal(headers(calls[1]).get("content-type"), null);
});
