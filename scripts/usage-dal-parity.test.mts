import assert from "node:assert/strict";
import test, { mock } from "node:test";

process.env.USE_CLOUDBASE_REST = "1";
const common = {
  at: new Date("2026-11-11T00:00:00Z"), uid: "offline", realm: "cn", provider: "",
  promptTokens: 1, completionTok: 1, totalTokens: 2, credit: 0, hasCredit: false,
  cacheHitTok: 0, cacheMissTok: 0, latencyMs: 1, tps: 1, modelRate: "", ok: true,
};
mock.module(new URL("../src/lib/dal.ts", import.meta.url).href, {
  namedExports: { dal: { usageEvent: { findMany: async () => [
    { ...common, id: "one", keyName: "a", model: "bc" },
    { ...common, id: "two", keyName: "ab", model: "c" },
  ] } } },
});
const { queryUsageAggregate } = await import("../src/lib/usage-query.ts");

test("CloudBase 密钥/模型复合分组与 PostgreSQL chr(1) 契约一致且不碰撞", async () => {
  const rows = await queryUsageAggregate({ $queryRaw: async () => { throw new Error("must not query real DB"); } }, {
    since: null, until: null, dayScope: true, groupDim: "",
  });
  for (const dimension of ["by_key_model", "by_pool_key_model"]) {
    const groups = rows.filter((row) => row.dimension === dimension);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map((row) => row.key).sort(), ["a\x01bc", "ab\x01c"].sort());
    assert.ok(groups.every((row) => Number(row.requests) === 1));
  }
});
