import assert from "node:assert/strict";
import test from "node:test";
import { getKey, setKey, req, reqCached, invalidateCache, PanelRequestError, PANEL_AUTH_REQUIRED_EVENT } from "../src/app/panel/lib.ts";

const storage = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalFetch = globalThis.fetch;
const windowTarget = new EventTarget();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
});
Object.defineProperty(globalThis, "window", { configurable: true, value: windowTarget });
test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});
test.beforeEach(() => { storage.clear(); invalidateCache(); });

test("面板请求携带保存的主密钥与必要的 JSON 类型", async () => {
  setKey("master-test-key");
  assert.equal(getKey(), "master-test-key");
  globalThis.fetch = async (_url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer master-test-key");
    assert.equal(headers.get("content-type"), "application/json");
    return Response.json({ ok: true, value: 1 });
  };
  assert.equal((await req<{ value: number }>("config", { method: "POST", body: {} })).value, 1);
});

test("HTTP 401 通知界面重新登录，并保留 HTTP 状态", async () => {
  let events = 0;
  const listener = () => { events++; };
  windowTarget.addEventListener(PANEL_AUTH_REQUIRED_EVENT, listener);
  try {
    globalThis.fetch = async () => Response.json({ ok: false, error: "bad key" }, { status: 401 });
    await assert.rejects(req("overview"), (error: unknown) => error instanceof PanelRequestError && error.status === 401);
    assert.equal(events, 1);
  } finally { windowTarget.removeEventListener(PANEL_AUTH_REQUIRED_EVENT, listener); }
});

test("换密钥后清除缓存，在途旧响应不写入新会话缓存", async () => {
  let resolveFirst!: (response: Response) => void;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
    return Response.json({ ok: true, value: "new" });
  };
  const old = reqCached("packages");
  setKey("new-key");
  assert.equal((await reqCached("packages")).value, "new");
  resolveFirst(Response.json({ ok: true, value: "old" }));
  await old;
  assert.equal((await reqCached("packages")).value, "new");
  assert.equal(calls, 2);
});

test("强制刷新优先，较旧并发响应不会覆盖新的缓存", async () => {
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
