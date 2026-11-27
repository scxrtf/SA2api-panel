import assert from "node:assert/strict";
import test, { mock } from "node:test";

let failed = false;
let reads = 0;
let rows = [{ name: "limited", key: "child-test-key", providers: "vendor" }];
let pendingRows: Promise<typeof rows> | null = null;
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
const { GET: panelConfig } = await import("../src/app/api/panel/config/route.ts");
const request = (key?: string) => new Request("http://localhost/api/panel/config", {
  headers: key ? { Authorization: "Bearer " + key } : undefined,
});

test.beforeEach(() => {
  rows = [{ name: "limited", key: "child-test-key", providers: "vendor" }];
  failed = false;
  reads = 0;
  pendingRows = null;
  invalidateKeyRing();
});

test("网站面板完全免验证密钥", async () => {
  for (const key of [undefined, "wrong", "child-test-key"]) {
    const response = await panelConfig(request(key));
    assert.equal(response.status, 200);
  }
  assert.equal(reads, 0, "管理接口不读取密钥表");
});

test("空子密钥环保持免密钥模式", async () => {
  rows = [];
  assert.equal(await verifyAny(request()), true);
  assert.deepEqual(await identifyKeyIdentity(request()), { name: "", providers: "*", unrestricted: true });
});

test("密钥表查询失败不再使未携带凭证的网关请求通过", async () => {
  failed = true;
  assert.equal(await verifyAny(request()), false);
  assert.equal(await verifyAny(request("child-test-key")), false);
  assert.equal(await identifyKeyIdentity(request()), null);
});

test("数据库故障时错误和子密钥关闭", async () => {
  failed = true;
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
  rows.push({ name: "new", key: "other-child-key", providers: "vendor" });
  resolveRows([{ name: "limited", key: "child-test-key", providers: "vendor" }]);
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(await verifyAny(request("child-test-key")), false);
  assert.equal(reads, 2);
});
