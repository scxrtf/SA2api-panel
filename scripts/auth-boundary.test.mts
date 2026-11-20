import assert from "node:assert/strict";
import test, { mock } from "node:test";

let master = "master-test-key";
let failed = false;
let reads = 0;
let rows = [{ name: "limited", key: "child-test-key", providers: "vendor" }];
let pendingRows: Promise<typeof rows> | null = null;
mock.module(new URL("../src/lib/config.ts", import.meta.url).href, {
  namedExports: { getConfig: async () => ({ api_key: master }) },
});
mock.module(new URL("../src/lib/db.ts", import.meta.url).href, {
  namedExports: {
    prisma: { apiKey: { findMany: async () => {
      reads++;
      if (failed) throw new Error("offline database unavailable");
      return pendingRows ?? rows;
    } } },
  },
});
const { extractToken, identifyKeyIdentity, invalidateKeyRing, verifyAny } = await import("../src/lib/auth-guard.ts");
const { panelAuth } = await import("../src/lib/panel-auth.ts");
const request = (key?: string) => new Request("http://localhost/api/panel/config", {
  headers: key ? { Authorization: "Bearer " + key } : undefined,
});

test.beforeEach(() => {
  master = "master-test-key";
  rows = [{ name: "limited", key: "child-test-key", providers: "vendor" }];
  failed = false;
  reads = 0;
  pendingRows = null;
  invalidateKeyRing();
});

test("面板只接受主密钥，拒绝空凭证、错误凭证和子密钥", async () => {
  for (const key of [undefined, "wrong", "child-test-key"]) {
    const response = await panelAuth(request(key));
    assert.equal(response?.status, 401);
    assert.equal(response?.headers.get("cache-control"), "no-store");
  }
  assert.equal(await panelAuth(request("master-test-key")), null);
  assert.equal(reads, 0, "管理鉴权不必查询子密钥表");
});

test("未配置主密钥的面板故障关闭，网关保留显式无密钥模式", async () => {
  master = "";
  assert.equal((await panelAuth(request()))?.status, 503);
  rows = [];
  assert.equal(await verifyAny(request()), true);
  assert.deepEqual(await identifyKeyIdentity(request()), { name: "", providers: "*", unrestricted: true });
});

test("密钥表查询失败不再使未携带凭证的网关请求通过", async () => {
  master = "";
  failed = true;
  assert.equal(await verifyAny(request()), false);
  assert.equal(await verifyAny(request("child-test-key")), false);
  assert.equal(await identifyKeyIdentity(request()), null);
});

test("数据库故障时主密钥仍有效，错误和子密钥关闭", async () => {
  failed = true;
  assert.equal(await verifyAny(request("master-test-key")), true);
  assert.equal(reads, 0);
  assert.equal(await verifyAny(request("child-test-key")), false);
  assert.equal(await verifyAny(request("wrong")), false);
});

test("子密钥身份与准入判定一致，保留供应商白名单", async () => {
  assert.equal(await verifyAny(request("child-test-key")), true);
  assert.deepEqual(await identifyKeyIdentity(request("child-test-key")), {
    name: "limited", providers: "vendor", unrestricted: false,
  });
  assert.equal(await verifyAny(request("wrong")), false);
  assert.equal(reads, 1, "同一 TTL 窗口内复用密钥快照");
});

test("Bearer scheme 不区分大小写，仍兼容 x-api-key", () => {
  assert.equal(extractToken(new Request("http://localhost", { headers: { Authorization: "bearer master-test-key" } })), "master-test-key");
  assert.equal(extractToken(new Request("http://localhost", { headers: { "x-api-key": "child-test-key" } })), "child-test-key");
});

test("冷缓存并发只查一次，失效后的旧在途快照不重新入缓存", async () => {
  let resolveRows!: (value: typeof rows) => void;
  pendingRows = new Promise((resolve) => { resolveRows = resolve; });
  const first = verifyAny(request("child-test-key"));
  const second = verifyAny(request("child-test-key"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reads, 1);
  invalidateKeyRing();
  pendingRows = null;
  rows = [];
  resolveRows([{ name: "limited", key: "child-test-key", providers: "vendor" }]);
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(await verifyAny(request("child-test-key")), false);
  assert.equal(reads, 2);
});
