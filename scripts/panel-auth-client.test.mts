import assert from "node:assert/strict";
import test from "node:test";
import { req, reqCached, invalidateCache } from "../src/app/panel/lib.ts";

const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
});
test.beforeEach(() => { invalidateCache(); });

test("面板请求不携带验证密钥，只设置必要的 JSON 类型", async () => {
  globalThis.fetch = async (_url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("content-type"), "application/json");
    return Response.json({ ok: true, value: 1 });
  };
  assert.equal((await req<{ value: number }>("config", { method: "POST", body: {} })).value, 1);
});

test("较旧并发响应不会覆盖强制刷新的缓存", async () => {
  let resolveFirst!: (response: Response) => void;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
    return Response.json({ ok: true, value: "new" });
  };
  const old = reqCached("packages");
  assert.equal((await reqCached("packages", { force: true })).value, "new");
  resolveFirst(Response.json({ ok: true, value: "old" }));
  await old;
  assert.equal((await reqCached("packages")).value, "new");
  assert.equal(calls, 2);
});

test("强制刷新立即拉新并覆盖旧缓存", async () => {
  let resolveFirst!: (response: Response) => void;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
    return Response.json({ ok: true, value: "fresh" });
  };
  const old = reqCached("packages");
  assert.equal((await reqCached("packages", { force: true })).value, "fresh");
  resolveFirst(Response.json({ ok: true, value: "stale" }));
  await old;
  assert.equal((await reqCached("packages")).value, "fresh");
  assert.equal(calls, 2);
});
