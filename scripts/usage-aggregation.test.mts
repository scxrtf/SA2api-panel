import assert from "node:assert/strict";
import test from "node:test";
import { buildUsageSnapshot } from "../src/lib/usage-aggregation.ts";
import { cachedUsageQuery } from "../src/lib/usage-cache.ts";
import { queryUsageAggregate } from "../src/lib/usage-query.ts";

process.env.WB2API_MODEL_JSON_DISABLE = "1";
// 本测试对拍的是 SQL 分支；.env 里 USE_CLOUDBASE_REST=1 会让 queryUsageAggregate
// 走 DAL 应用层聚合（无 db.$queryRaw 调用），这里显式关掉。
process.env.USE_CLOUDBASE_REST = "0";

const zero = {
  errors: 0n, credit: 0, creditSamples: 0n, creditTokens: 0n,
  cacheHit: 0n, cacheMiss: 0n, latSum: 0n, latSamples: 0n, tpsSum: 0, tpsSamples: 0n,
};
function row(dimension, key, extra = {}) {
  return {
    dimension, key, realm: "", extra: "", bucket: "", eventAt: null,
    requests: 1n, prompt: 100n, completion: 50n, total: 150n,
    ...zero, ...extra,
  };
}

test("数据库聚合行保持用量响应字段与计算口径", () => {
  const at = "2026-11-04T01:00:00.000Z";
  const rows = [
    row("totals", "", { eventAt: at, requests: 2n, prompt: 200n, completion: 100n, total: 300n }),
    row("by_account", "account-123456", { realm: "cn", requests: 2n }),
    row("credit_by_account", "account-123456", { requests: 1n, credit: 0.25, creditSamples: 1n, creditTokens: 150n }),
    row("series", "", { bucket: "2026-11-04T09" }),
    row("series_group", "account-123456", { realm: "cn", bucket: "2026-11-04T09" }),
  ];
  const out = buildUsageSnapshot(rows, new Map([["account-123456", "主账号"]]), {
    dayScope: false, groupDim: "account", windowFrom: "", windowTo: "",
    generated: new Date("2026-11-04T02:00:00.000Z"),
  });
  assert.equal(out.totals.total_tokens, 300);
  assert.equal(out.buckets, 2);
  assert.equal(out.since, at);
  assert.equal(out.by_account[0].extra, "主账号");
  assert.equal(out.credit_by_account[0].nickname, "主账号");
  assert.equal(out.series[0].t, Date.parse("2026-11-04T09:00:00+08:00"));
  assert.equal(out.series_group.groups[0].label, "主账号");
  assert.equal(out.generated, "2026-11-04T02:00:00.000Z");
});

test("同参数缓存与并发共用一次数据库调用，异常不进入缓存", async () => {
  const key = "usage-cache-test-" + Date.now();
  let resolveFirst;
  let calls = 0;
  const loader = () => {
    calls++;
    return new Promise((resolve) => { resolveFirst = resolve; });
  };
  const one = cachedUsageQuery(key, loader);
  const two = cachedUsageQuery(key, loader);
  assert.equal(one, two);
  assert.equal(calls, 1);
  resolveFirst({ ok: true });
  assert.deepEqual(await one, { ok: true });

  const failedKey = key + "-failed";
  await assert.rejects(cachedUsageQuery(failedKey, async () => { throw new Error("test"); }));
  assert.equal(await cachedUsageQuery(failedKey, async () => "recovered"), "recovered");
});

test("聚合 SQL 由 PostgreSQL 分组，并参数化时间过滤", async () => {
  let captured;
  const db = {
    async $queryRaw(query) {
      captured = query;
      return [];
    },
  };
  await queryUsageAggregate(db, {
    since: new Date("2026-11-01T00:00:00Z"), until: null, dayScope: false, groupDim: "account",
  });
  const sql = captured.sql;
  assert.match(sql, /FROM "UsageEvent"/);
  assert.match(sql, /GROUP BY "uid"/);
  assert.match(sql, /AT TIME ZONE 'Asia\/Shanghai'/);
  assert.match(sql, /SELECT 'series_group'/);
  assert.ok(!sql.includes("2026-11-01T00:00:00.000Z"));
  assert.ok(captured.values.some((v) => v instanceof Date));
});
