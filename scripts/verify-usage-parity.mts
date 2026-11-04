// 真实数据库只读对拍：同一批事件分别走旧 Node 聚合与新 PostgreSQL 聚合。
// 运行：npm run verify:usage
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import pg from "pg";
import { queryUsageAggregate } from "../src/lib/usage-query";
import { buildUsageSnapshot } from "../src/lib/usage-aggregation";
import { legacyUsageRows, type SeriesDim } from "../src/lib/usage-legacy";

process.env.WB2API_MODEL_JSON_DISABLE = "1";
// 只读对拍走 5432 直连；池化器会对超过其空闲/超时阈值的慢查询回收连接。
const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL/DIRECT_URL 未配置");
const CLIENT_OPTS = {
  connectionString: url,
  keepAlive: true,
  keepAliveInitialDelayMillis: 15_000,
} as const;

let client = new pg.Client(CLIENT_OPTS);
async function connect(): Promise<void> {
  client = new pg.Client(CLIENT_OPTS);
  await client.connect();
  await client.query(`SET statement_timeout = 0`);
  // UsageEvent."at" 是 timestamp without time zone（Prisma 按 UTC 写墙钟）。
  // 固定会话时区，保证 WHERE 比较与 AT TIME ZONE 转换可复现。
  await client.query(`SET TIME ZONE 'UTC'`);
}
async function reconnect(): Promise<void> {
  try { await client.end(); } catch { /* 旧连接可能已断开，忽略 */ }
  await connect();
}
await connect();

// 单次结果集过大时 Supabase 侧会在传输中途回收连接；分块 + 失败重连保证对拍可完成。
async function run<T extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await client.query<T>(text, values as unknown[] as never[]);
    } catch (error) {
      if (attempt >= 3) throw error;
      console.warn(`query failed (attempt ${attempt}): ${(error as Error).message} -> reconnect`);
      await reconnect();
    }
  }
}

// 用一条原始 SQL 验证连接活跃并取回 UsageEvent 行数。
const probe = await run<{ n: string }>(`SELECT count(*)::bigint AS n FROM "UsageEvent"`);
console.log(`connected: UsageEvent rows = ${probe.rows[0]?.n}`);

// 全表 2.4 万行 × 18 列在实测链路上要传十几分钟，中途会被 Supabase 断连。
// 默认只对最近一段窗口做真实对拍（覆盖全部维度与日桶口径）；VERIFY_FULL=1 才拉全表。
const FULL = process.env.VERIFY_FULL === "1";
const WINDOW_HOURS = Math.min(Math.max(Number(process.env.VERIFY_WINDOW_HOURS ?? 12) || 12, 1), 168);
const windowStart = new Date(Date.now() - WINDOW_HOURS * 3600_000);

interface RawEventRow {
  id: string; at: Date; uid: string; model: string; realm: string; provider: string | null;
  promptTokens: number; completionTok: number; totalTokens: number;
  credit: number; hasCredit: boolean; cacheHitTok: number; cacheMissTok: number;
  latencyMs: number; tps: number; keyName: string; modelRate: string; ok: boolean;
}

// node-postgres 会把 timestamp without time zone 按本机时区（Asia/Shanghai）解析，
// 直接取 "at" 会让每个事件早 8 小时；这里显式还原成 timestamptz。
const EVENT_COLUMNS = `"id", ("at" AT TIME ZONE 'UTC') AS "at", "uid", "model", "realm", "provider", "promptTokens", "completionTok",
  "totalTokens", "credit", "hasCredit", "cacheHitTok", "cacheMissTok", "latencyMs",
  "tps", "keyName", "modelRate", "ok"`;
const CHUNK_ROWS = 2_000;

async function loadEvents(since: Date | null): Promise<RawEventRow[]> {
  const out: RawEventRow[] = [];
  let cursorAt: Date | null = null;
  let cursorId = "";
  for (;;) {
    // pg 把 JS Date 序列化成带本机偏移的字面量（如 2026-11-04T13:07:36+08:00）。
    // 直接与 timestamp without time zone 比较会取到本地墙钟、整体后移 8 小时；
    // 这里统一先还原成 UTC 时刻再落成 naive，与 "at" 的写入口径对齐。
    const res = cursorAt
      ? await run<RawEventRow>(
          `SELECT ${EVENT_COLUMNS} FROM "UsageEvent"
            WHERE ("at", "id") > (($1::timestamptz AT TIME ZONE 'UTC'), $2)${
              since ? ` AND "at" >= ($4::timestamptz AT TIME ZONE 'UTC')` : ""
            }
            ORDER BY "at" ASC, "id" ASC LIMIT $3`,
          since ? [cursorAt, cursorId, CHUNK_ROWS, since] : [cursorAt, cursorId, CHUNK_ROWS],
        )
      : await run<RawEventRow>(
          since
            ? `SELECT ${EVENT_COLUMNS} FROM "UsageEvent"
                WHERE "at" >= ($2::timestamptz AT TIME ZONE 'UTC')
                ORDER BY "at" ASC, "id" ASC LIMIT $1`
            : `SELECT ${EVENT_COLUMNS} FROM "UsageEvent"
                ORDER BY "at" ASC, "id" ASC LIMIT $1`,
          since ? [CHUNK_ROWS, since] : [CHUNK_ROWS],
        );
    if (res.rows.length === 0) break;
    for (const r of res.rows) out.push({ ...r, provider: r.provider ?? undefined });
    const last = res.rows[res.rows.length - 1];
    cursorAt = last.at;
    cursorId = last.id;
    if (res.rows.length < CHUNK_ROWS) break;
  }
  return out;
}

const allEvents = await loadEvents(FULL ? null : windowStart);
console.log(
  FULL
    ? `loaded: ${allEvents.length} UsageEvent rows (full history) in chunks of ${CHUNK_ROWS}`
    : `loaded: ${allEvents.length} UsageEvent rows (last ${WINDOW_HOURS}h) in chunks of ${CHUNK_ROWS}`,
);
const accounts = (await run<{ uid: string; nickname: string }>(
  `SELECT "uid", "nickname" FROM "Account"`,
)).rows;

const db = {
  async $queryRaw<T>(query: Prisma.Sql): Promise<T> {
    const { rows } = await run(query.text, query.values);
    return rows as T;
  },
  $disconnect: async () => client.end(),
};

function comparable(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const copy = { ...(value as Record<string, unknown>) };
  delete copy.generated;
  // 毫秒级浮点求和顺序不同；有效精度远高于面板展示精度。
  return JSON.parse(JSON.stringify(copy, (_key, item) =>
    typeof item === "number" && !Number.isInteger(item) ? Number(item.toFixed(8)) : item));
}

try {
  const started = performance.now();
  const nicks = new Map(accounts.map((a) => [a.uid, a.nickname]));
  const latest = allEvents.at(-1)?.at ?? new Date();
  const earliest = allEvents[0]?.at ?? latest;
  // 生产库在跑，对拍期间会持续写入新行。把右边界固定在已加载的最后一条事件上，
  // 否则 SQL 侧会把对拍开始后才写入的行也算进来，与 Node 侧快照错开。
  const snapshotUntil = latest;
  const cases: { name: string; since: Date | null; until: Date | null; dayScope: boolean; groupDim: SeriesDim | "" }[] = [];
  const baseSince = FULL ? new Date(latest.getTime() - 72 * 3600_000) : windowStart;
  const scope = FULL ? "72h" : `${WINDOW_HOURS}h`;
  for (const groupDim of ["", "account", "key", "model", "provider", "realm"] as const) {
    cases.push({ name: `${scope}/group=${groupDim || "none"}`, since: baseSince, until: snapshotUntil, dayScope: false, groupDim });
  }
  cases.push(
    FULL
      ? { name: "all-history/day", since: null, until: snapshotUntil, dayScope: true, groupDim: "account" }
      : { name: `${scope}/day`, since: baseSince, until: snapshotUntil, dayScope: true, groupDim: "account" },
    { name: "empty", since: new Date(latest.getTime() + 3600_000), until: null, dayScope: false, groupDim: "account" },
    {
      name: "explicit-from-to",
      since: earliest,
      // 右边界同样收敛到快照末行，避免把对拍期间新写入的事件算进 SQL 侧。
      until: new Date(Math.min(
        earliest.getTime() + (FULL ? 24 : 6) * 3600_000,
        snapshotUntil.getTime(),
      )),
      dayScope: false,
      groupDim: "provider",
    },
  );
  if (!FULL) {
    cases.push({ name: "last-1h", since: new Date(latest.getTime() - 3600_000), until: snapshotUntil, dayScope: false, groupDim: "model" });
  }
  let comparedRows = 0;
  const results = [];
  for (const item of cases) {
    const events = allEvents.filter((e) => (!item.since || e.at >= item.since) && (!item.until || e.at <= item.until));
    const legacy = buildUsageSnapshot(legacyUsageRows(events, item.dayScope, item.groupDim), nicks, {
      dayScope: item.dayScope, groupDim: item.groupDim, windowFrom: "", windowTo: "",
    });
    const sqlStart = performance.now();
    const sqlRows = await queryUsageAggregate(db, item);
    const sqlMs = Math.round(performance.now() - sqlStart);
    const actual = buildUsageSnapshot(sqlRows, nicks, {
      dayScope: item.dayScope, groupDim: item.groupDim, windowFrom: "", windowTo: "",
    });
    assert.deepEqual(comparable(actual), comparable(legacy), `${item.name} 响应不一致`);
    comparedRows += sqlRows.length;
    results.push({ case: item.name, events: events.length, aggregate_rows: sqlRows.length, sql_ms: sqlMs, passed: true });
    console.log(`PASS ${item.name}: ${events.length} events -> ${sqlRows.length} aggregate rows (${sqlMs}ms)`);
  }
  console.log(JSON.stringify({
    ok: true, cases: results.length, compared_aggregate_rows: comparedRows,
    elapsed_ms: Math.round(performance.now() - started), results,
    note: "旧/新算法完整响应逐字段一致；仅读取数据库；未执行写入",
  }, null, 2));
} finally {
  await db.$disconnect();
}
