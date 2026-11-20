import assert from "node:assert/strict";
import test, { mock } from "node:test";

process.env.USE_CLOUDBASE_REST = "0";
let idleMs = 25;
const logs: Record<string, unknown>[] = [];
const provider = { name: "offline-timeout", models: "", apiKey: "test-key", baseUrl: "https://provider.invalid/v1" };
mock.module(new URL("../src/lib/db.ts", import.meta.url).href, {
  namedExports: { prisma: {
    setting: { findUnique: async () => ({ value: JSON.stringify({ stream_idle_ms: idleMs }) }) },
    provider: { findMany: async () => [provider] },
    requestLog: { create: async ({ data }: { data: Record<string, unknown> }) => {
      logs.push(data); return { id: "offline-log" };
    } },
    usageEvent: { create: async () => ({}) },
  } },
});
const { providerChat } = await import("../src/lib/provider.ts");
const { getConfig } = await import("../src/lib/config.ts");
const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; });
const body = JSON.stringify({ model: "test", messages: [{ role: "user", content: "offline" }] });

for (const status of [200, 429]) {
  test(`供应商 HTTP ${status} 非 SSE 响应体停顿会超时并取消上游，不记成功`, async (t) => {
    idleMs = 25;
    await getConfig(true);
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
    let cancelled = false;
    let source!: ReadableStreamDefaultController<Uint8Array>;
    let reachedRead: () => void = () => undefined;
    const reading = new Promise<void>((resolve) => { reachedRead = resolve; });
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller; controller.enqueue(new TextEncoder().encode('{"partial":')); },
      pull() { reachedRead(); },
      cancel() { cancelled = true; },
    }), { status, headers: { "Content-Type": "application/json" } });
    // 原实现会一直等响应体。有限兜底保留失败现场，同时不把测试挂死。
    const fallback = setTimeout(() => { if (!cancelled) source.close(); }, 1500);
    t.after(() => { clearTimeout(fallback); t.mock.timers.reset(); });
    const pending = providerChat(provider.name, "test", body, false);
    await reading;
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(50);
    const response = await pending;
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, "provider_body_timeout");
    assert.equal(cancelled, true);
    assert.equal(logs.at(-1)?.errKind, "provider_body_timeout");
  });
}

test("非 SSE 响应体读取期间客户端取消保持 499 语义", async () => {
  const controller = new AbortController();
  globalThis.fetch = async (_url, init) => new Response(new ReadableStream<Uint8Array>({
    start(source) {
      init?.signal?.addEventListener("abort", () => source.error(new DOMException("cancelled", "AbortError")), { once: true });
      setImmediate(() => controller.abort());
    },
  }), { headers: { "Content-Type": "application/json" } });
  const response = await providerChat(provider.name, "test", body, false, "", "", {
    started: Date.now(), clientIP: "", ua: "", path: "/test", signal: controller.signal,
  });
  assert.equal(response.status, 499);
  assert.equal((await response.json()).error.code, "client_cancelled");
});

test("完整供应商 JSON 仍逐字透传，不受 body watchdog 改写", async () => {
  const raw = '{ "choices": [], "usage": { "total_tokens": 7 } }';
  globalThis.fetch = async () => new Response(raw, { headers: { "Content-Type": "application/json" } });
  const response = await providerChat(provider.name, "test", body, false);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), raw);
});
