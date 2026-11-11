import assert from "node:assert/strict";
import test from "node:test";
import { BALANCE_HISTORY_CACHE_MS, panelCacheTtlMs } from "../src/lib/balance-history-cache.ts";
import { panelCacheGet, panelCacheSet, panelCacheStats } from "../src/lib/panel-cache.ts";

test("余额趋势采用 60 秒短缓存，其他面板数据仍保留 1 小时", () => {
  assert.equal(BALANCE_HISTORY_CACHE_MS, 60_000);
  assert.equal(panelCacheTtlMs("balance_history:30"), 60_000);
  assert.equal(panelCacheTtlMs("packages"), 3_600_000);
});

test("余额缓存过期后重取，状态页显示独立 TTL 并清理过期项", () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-11-11T03:00:00.000Z");
  Date.now = () => now;
  try {
    panelCacheSet("balance_history:30", { series: [{ current: 100 }] });
    panelCacheSet("packages", { accounts: [] });
    assert.deepEqual(panelCacheGet("balance_history:30"), { series: [{ current: 100 }] });
    now += 59_999;
    assert.deepEqual(panelCacheGet("balance_history:30", BALANCE_HISTORY_CACHE_MS), { series: [{ current: 100 }] });
    now += 1;
    assert.equal(panelCacheGet("balance_history:30", BALANCE_HISTORY_CACHE_MS), null);
    assert.notEqual(panelCacheGet("packages"), null);

    panelCacheSet("balance_history:30", { series: [{ current: 200 }] });
    const balanceEntry = panelCacheStats().entries.find((entry) => entry.key === "balance_history:30");
    assert.equal(balanceEntry?.ttlMs, BALANCE_HISTORY_CACHE_MS);
    assert.deepEqual(panelCacheGet("balance_history:30", BALANCE_HISTORY_CACHE_MS), { series: [{ current: 200 }] });
    now += BALANCE_HISTORY_CACHE_MS;
    assert.equal(panelCacheStats().entries.some((entry) => entry.key === "balance_history:30"), false);
  } finally {
    Date.now = originalNow;
  }
});
