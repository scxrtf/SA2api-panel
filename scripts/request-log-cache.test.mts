import assert from "node:assert/strict";
import { test } from "node:test";
import { readCacheStatus } from "../src/lib/cache-status";
import { databaseCache } from "../src/lib/database-cache";
import { panelCacheDel, panelCacheSet } from "../src/lib/panel-cache";
import { formatCacheRate, requestCacheUsage, summarizeRequestPage } from "../src/lib/request-log-metrics";
import { cachedUsageQuery } from "../src/lib/usage-cache";

test("request logs distinguish no cache data, real misses and real hits", () => {
  assert.deepEqual(requestCacheUsage({}), { hit: 0, miss: 0, rate: null });
  assert.deepEqual(requestCacheUsage({ cacheHitTok: 0, cacheMissTok: 0 }), { hit: 0, miss: 0, rate: null });
  assert.deepEqual(requestCacheUsage({ cacheHitTok: 0, cacheMissTok: 250 }), { hit: 0, miss: 250, rate: 0 });
  assert.deepEqual(requestCacheUsage({ cacheHitTok: 500, cacheMissTok: 0 }), { hit: 500, miss: 0, rate: 1 });
  assert.equal(formatCacheRate(0), "0%");
  assert.equal(formatCacheRate(0.0004), "<0.1%");
  assert.equal(formatCacheRate(0.9999), ">99.9%");
  assert.equal(formatCacheRate(1), "100%");
});

test("the current-page hit rate is token-weighted and detects HTTP 200 stream errors", () => {
  const result = summarizeRequestPage([
    { status: 200, cacheHitTok: 90, cacheMissTok: 10 },
    { status: 200, errKind: "provider_stream_error", cacheHitTok: 0, cacheMissTok: 900 },
    { status: 429 },
  ]);
  assert.deepEqual(result, { count: 3, failed: 2, reported: 2, rate: 0.09 });
  assert.equal(summarizeRequestPage([{ status: 200 }]).rate, null);
});

test("cache status uses per-key TTLs and independent database/platform expiration", async (t) => {
  t.after(() => {
    panelCacheDel();
    databaseCache.stats.clear();
    databaseCache.platform.clear();
  });
  panelCacheSet("models", { payload: "must-not-appear" });
  panelCacheSet("model_probes", { payload: "must-not-appear" });
  panelCacheSet("balance_history:24", { payload: "must-not-appear" });
  await cachedUsageQuery("rollup", async () => ({ payload: "must-not-appear" }));
  const at = Date.now();
  databaseCache.stats.set({ payload: "must-not-appear" }, at);
  databaseCache.platform.set(null, at);

  const snapshot = readCacheStatus(at);
  const [panel, usage, stats, platform] = snapshot.layers;
  assert.equal(snapshot.at, at);
  assert.equal(panel.maxEntries, 64);
  assert.equal(panel.entries.find((e) => e.key === "models")?.configuredTtlMs, 3_600_000);
  assert.equal(panel.entries.find((e) => e.key === "model_probes")?.configuredTtlMs, 60_000);
  assert.equal(panel.entries.find((e) => e.key === "balance_history:24")?.configuredTtlMs, 60_000);
  assert.equal(usage.maxEntries, 64);
  assert.equal(usage.entries[0]?.configuredTtlMs, 20_000);
  assert.equal(stats.entries[0]?.ttlMs, 3_600_000);
  assert.equal(platform.entries[0]?.ttlMs, 60_000);
  assert.match(platform.note, /空结果/);
  assert.doesNotMatch(JSON.stringify(snapshot), /must-not-appear/);

  const expired = readCacheStatus(at + 60_001);
  assert.deepEqual(expired.layers.map((layer) => layer.size), [1, 0, 1, 0]);
  assert.equal(expired.layers[2].entries[0].ttlMs, 3_539_999);
  assert.equal(databaseCache.platform.get(at + 60_001), null);
  databaseCache.stats.clear();
  assert.equal(readCacheStatus(at + 60_001).layers[2].size, 0);
});
