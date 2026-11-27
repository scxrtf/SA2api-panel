import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { panelCacheDel } from "../src/lib/panel-cache.ts";

process.env.USE_CLOUDBASE_REST = "1";
process.env.CLOUDBASE_POSTGREST_URL = "https://offline-cloudbase.invalid/rest";
process.env.CLOUDBASE_API_KEY = "offline-test";
process.env.TZ = "UTC";
const originalFetch = globalThis.fetch;
const now = Date.now();
const samples = Array.from({ length: 2501 }, (_, index) => ({
  id: `offline-${index}`, uid: "offline-balance", at: new Date(now - 3_000_000 + index * 1000).toISOString(),
  credits: String(index), day: "", first: "0", consumed: "0", gained: "0",
}));
const offsets: number[] = [];
let accountReads = 0;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  assert.equal(url.hostname, "offline-cloudbase.invalid");
  if (url.pathname.endsWith("/Account")) {
    accountReads++;
    return Response.json([{ uid: "offline-balance", nickname: "Offline", realm: "cn" }]);
  }
  assert.ok(url.pathname.endsWith("/BalanceSample"));
  const offset = Number(url.searchParams.get("offset") || "0");
  offsets.push(offset);
  const limit = Math.min(1000, Number(url.searchParams.get("limit") || "1000"));
  return Response.json(samples.slice(offset, offset + limit));
};
test.after(() => { globalThis.fetch = originalFetch; });
const { dal } = await import("../src/lib/dal.ts");
mock.module(new URL("../src/lib/db.ts", import.meta.url).href, { namedExports: { prisma: dal } });
mock.module(new URL("../src/lib/panel-auth.ts", import.meta.url).href, {
  namedExports: {
    ok: (data: Record<string, unknown>) => Response.json({ ok: true, ...data }),
  },
});
const { GET } = await import("../src/app/api/panel/balance_history/route.ts");

function getHistory(days: number, refresh = false) {
  return GET(new Request(`http://localhost/api/panel/balance_history?days=${days}${refresh ? "&refresh=1" : ""}`));
}

test("CloudBase 余额历史超过单页 1000 行仍读全并包含最新水位", async () => {
  const response = await getHistory(30, true);
  const payload = await response.json();
  assert.equal(payload.source, "cloudbase");
  assert.equal(payload.series[0].points.length, 2501);
  assert.equal(payload.series[0].current, 2500);
  assert.deepEqual(offsets, [0, 1000, 2000]);
});

test("刷新 1 天余额窗口保留已缓存的 10 天窗口", async () => {
  panelCacheDel();
  await getHistory(10);
  await getHistory(1, true);
  const before = accountReads;
  const hit = await getHistory(10);
  assert.equal((await hit.json()).cached, true);
  assert.equal(accountReads, before);
});

test("余额窗口的并发冷查询和并发强刷分别只查询一次", async () => {
  panelCacheDel();
  const before = accountReads;
  for (const refresh of [false, true]) {
    const responses = await Promise.all(Array.from({ length: 5 }, () => getHistory(7, refresh)));
    const data = await Promise.all(responses.map((response) => response.json()));
    assert.equal(data.every((item) => item.days === 7 && item.cached === undefined), true);
    assert.equal(accountReads, before + (refresh ? 2 : 1));
  }
  assert.equal((await (await getHistory(7)).json()).cached, true);
});
