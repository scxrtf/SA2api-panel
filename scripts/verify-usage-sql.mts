// 对当前配置的数据库执行真实聚合与前后算法对拍，不写入业务表。
// 运行：npx tsx scripts/verify-usage-sql.mts
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { queryUsageAggregate } from "../src/lib/usage-query";
import { buildUsageSnapshot } from "../src/lib/usage-aggregation";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL 未配置");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
try {
  const since = new Date(Date.now() - 72 * 3600_000);
  const started = performance.now();
  const [rows, accounts] = await Promise.all([
    queryUsageAggregate(db, { since, until: null, dayScope: false, groupDim: "account" }),
    db.account.findMany({ select: { uid: true, nickname: true } }),
  ]);
  const snapshot = buildUsageSnapshot(rows, new Map(accounts.map((a) => [a.uid, a.nickname])), {
    dayScope: false, groupDim: "account", windowFrom: "", windowTo: "",
  });
  const elapsed = Math.round(performance.now() - started);
  console.log(JSON.stringify({
    ok: true,
    source_rows_scanned_in_database: snapshot.buckets,
    aggregate_rows_returned_to_node: rows.length,
    accounts: accounts.length,
    response_dimensions: Object.keys(snapshot).length,
    total_tokens: snapshot.totals.total_tokens,
    elapsed_ms_including_account_query: elapsed,
    note: "72h 窗口；UsageEvent 明细未传出数据库；未执行写入",
  }, null, 2));
} finally {
  await db.$disconnect();
}