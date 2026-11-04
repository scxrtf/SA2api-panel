// Egress 瘦身（清 RequestLog 大字段 + 建复合索引 + VACUUM）。
//
// 背景：RequestLog 的 requestMessages / responseMessage / attemptDetails /
// parameterOverrides 是 JSONB TOAST 大字段，单行可达 190 KB。面板「请求日志」
// 列表与详情都会把这些列读出去，Supabase 免费档 Egress 因此被撑到 269%。
// chat.ts 已在写入侧按 REQUEST_LOG_DIALOG 门控，本脚本负责把库里**已经写进去**的
// 存量清掉，并补齐过滤用的复合索引，最后 VACUUM FULL 把磁盘真正还回去。
//
// 用法：
//   node scripts/egress-slim.cjs                    # 只体检：体积 / 带大字段行数 / 索引缺口
//   node scripts/egress-slim.cjs --apply            # 清最近 24h（含更早）大字段 + VACUUM FULL
//   node scripts/egress-slim.cjs --apply --hours=6  # 只清最近 6h 的行；更老的交给 retention
//   node scripts/egress-slim.cjs --apply --hours=0  # 全表所有行（不加时间下界）
//   node scripts/egress-slim.cjs --apply --no-vacuum# 只清字段，不重写整表
//   node scripts/egress-slim.cjs --indexes          # 只建 4 条复合索引（IF NOT EXISTS）
//   node scripts/egress-slim.cjs --apply --indexes  # 清字段 + 建索引 + VACUUM
//
// 语义提醒：--hours=N 选的是「最近 N 小时」这个处理窗口，不是「N 小时以前」。
// 默认 24 = 覆盖 REQUEST_LOG_DETAIL_HOURS 保留窗口内的全部行；更老的行由
// src/lib/retention.ts 的 clearRequestLogDetails 每 6h 负责。
const { Client } = require("pg");
const fs = require("fs");

function envValue(key) {
  if (process.env[key]) return process.env[key];
  const raw = fs.readFileSync(".env", "utf8");
  const m = raw.match(new RegExp("^" + key + '="([^"]+)"', "m"));
  return m ? m[1] : null;
}

// 应用连接（6543 transaction pooler）。体检与分批 UPDATE 走这里。
function databaseUrl() {
  const url = envValue("DATABASE_URL");
  if (!url) throw new Error(".env 中找不到 DATABASE_URL");
  return url;
}

// 直连 5432（session 模式）。VACUUM FULL / CREATE INDEX 必须走这条，
// transaction pooler 会在事务边界掐断。
function directUrl() {
  return envValue("DIRECT_URL") || databaseUrl();
}

function fmt(bytes) {
  const n = Number(bytes || 0);
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB";
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const INDEXES = argv.includes("--indexes");
const NO_VACUUM = argv.includes("--no-vacuum");
const hoursArg = argv.find((a) => a.startsWith("--hours="));
const HOURS = hoursArg ? Number(hoursArg.slice("--hours=".length)) : 24;
if (!Number.isFinite(HOURS) || HOURS < 0) {
  console.error("--hours 需要 >= 0 的数字，收到: " + hoursArg);
  process.exit(1);
}
const BATCH = 500;

const WANT_INDEXES = [
  ["RequestLog_status_at_idx", '"status","at"'],
  ["RequestLog_errKind_at_idx", '"errKind","at"'],
  ["RequestLog_model_at_idx", '"model","at"'],
  ["RequestLog_keyName_at_idx", '"keyName","at"'],
];

// 只清「确实还有东西」的行，避免每轮 UPDATE 空转制造死元组。
const HEAVY_PREDICATE = `(
  "requestMessages" is not null
  or "responseMessage" is not null
  or "attemptDetails" is not null
  or "parameterOverrides" is not null
  or coalesce("errorDetail", '') <> ''
)`;

let client = null;

async function openClient(url, statementTimeout) {
  const c = new Client({
    connectionString: url,
    statement_timeout: statementTimeout,
    query_timeout: 0,
  });
  await c.connect();
  // Supabase 超额只读只是库级默认参数 default_transaction_read_only=on；
  // 实例仍是主库（pg_is_in_recovery=false），会话内 SET 覆盖合法。
  await c.query("set default_transaction_read_only = off");
  return c;
}

async function stats(c) {
  const { rows } = await c.query(`
    select pg_size_pretty(pg_total_relation_size('"RequestLog"')) as tbl,
           pg_total_relation_size('"RequestLog"')::bigint as tbl_bytes,
           pg_size_pretty(pg_database_size(current_database())) as db,
           pg_database_size(current_database())::bigint as db_bytes`);
  return rows[0];
}

(async () => {
  client = await openClient(databaseUrl(), 600000);

  const { rows: head } = await client.query(`
    select current_setting('default_transaction_read_only') as dro,
           current_setting('transaction_read_only') as tro,
           pg_is_in_recovery() as rec,
           current_database() as dbname`);
  const replica = head[0].rec === true;
  console.log(
    "数据库:", head[0].dbname,
    "| 事务只读:", head[0].tro === "on" ? "是" : "否（已解除）",
    "| 实例角色:", replica ? "只读副本" : "主库",
  );
  if (replica) {
    console.log("实例是只读副本，写操作必然被拒。本次不做任何改动。");
    await client.end().catch(() => {});
    process.exitCode = 2;
    return;
  }

  const before = await stats(client);
  console.log("RequestLog:", before.tbl, "| 整库:", before.db);

  const { rows: cols } = await client.query(`
    select count(*)::bigint as total,
           count(*) filter (where ${HEAVY_PREDICATE})::bigint as heavy,
           pg_size_pretty(coalesce(sum(
             coalesce(pg_column_size("requestMessages"), 0)
             + coalesce(pg_column_size("responseMessage"), 0)
             + coalesce(pg_column_size("attemptDetails"), 0)
             + coalesce(pg_column_size("parameterOverrides"), 0)
             + coalesce(pg_column_size("errorDetail"), 0)), 0)::bigint) as heavy_bytes,
           pg_size_pretty(coalesce(sum(coalesce(pg_column_size("requestMessages"), 0)), 0)::bigint) as rm_bytes
      from "RequestLog"`);
  console.log(
    "总行数 " + cols[0].total + " | 带详情字段 " + cols[0].heavy +
    " 行 / " + cols[0].heavy_bytes + "（其中 requestMessages " + cols[0].rm_bytes + "）",
  );

  const windowSql = `($1::int = 0 or "at" >= now() - make_interval(hours => $1::int))`;
  const { rows: target } = await client.query(`
    select count(*)::bigint as rows,
           coalesce(sum(
             coalesce(pg_column_size("requestMessages"), 0)
             + coalesce(pg_column_size("responseMessage"), 0)
             + coalesce(pg_column_size("attemptDetails"), 0)
             + coalesce(pg_column_size("parameterOverrides"), 0)
             + coalesce(pg_column_size("errorDetail"), 0)), 0)::bigint as bytes
      from "RequestLog"
     where ${windowSql} and ${HEAVY_PREDICATE}`, [HOURS]);
  console.log(
    "处理窗口: " + (HOURS === 0 ? "全表" : "最近 " + HOURS + " 小时") +
    " | 命中 " + target[0].rows + " 行 / 行数据约 " + fmt(target[0].bytes),
  );

  const { rows: idx } = await client.query(`
    select indexrelname as name, pg_size_pretty(pg_relation_size(indexrelid)) as sz
      from pg_stat_user_indexes where relname = 'RequestLog' order by indexrelname`);
  const have = new Set(idx.map((i) => i.name));
  const missing = WANT_INDEXES.filter(([n]) => !have.has(n)).map(([n]) => n);
  console.log("索引: " + (idx.length ? idx.map((i) => i.name + "(" + i.sz + ")").join(", ") : "无"));
  console.log(missing.length ? "缺索引: " + missing.join(", ") : "4 条 Egress 复合索引齐全");

  if (!APPLY && !INDEXES) {
    console.log("\n[体检模式] 未改动任何数据。执行清理: --apply；建索引: --indexes。");
    await client.end().catch(() => {});
    return;
  }

  if (APPLY) {
    if (Number(target[0].rows) === 0) {
      console.log("窗口内没有需要清空的行，跳过 UPDATE。");
    } else {
      let updated = 0;
      const startedAt = Date.now();
      for (;;) {
        const res = await client.query(`
          update "RequestLog"
             set "requestMessages" = null,
                 "responseMessage" = null,
                 "attemptDetails" = null,
                 "parameterOverrides" = null,
                 "errorDetail" = ''
           where ctid in (
             select ctid from "RequestLog"
              where ${windowSql} and ${HEAVY_PREDICATE}
              limit $2::int
           )`, [HOURS, BATCH]);
        const n = res.rowCount || 0;
        updated += n;
        process.stdout.write("\r  已清空 " + updated + " 行");
        if (n < BATCH) break;
      }
      console.log("\n清空完成: " + updated + " 行，耗时 " +
        ((Date.now() - startedAt) / 1000).toFixed(1) + "s");
    }
    await client.end().catch(() => {});
    client = null;

    const vac = await openClient(directUrl(), 0);
    try {
      if (NO_VACUUM) {
        console.log("按 --no-vacuum 跳过 VACUUM；磁盘占用要等 autovacuum 才回落。");
      } else {
        console.log('VACUUM FULL ANALYZE "RequestLog" ...（独占锁，期间该表不可用）');
        const vacStart = Date.now();
        try {
          await vac.query('vacuum (full, analyze) "RequestLog"');
          console.log("VACUUM FULL 完成，耗时 " + ((Date.now() - vacStart) / 1000).toFixed(1) + "s");
        } catch (e) {
          console.log("VACUUM FULL 失败（" + String(e.message).split("\n")[0] + "）→ 退化为普通 VACUUM");
          await vac.query('vacuum (analyze) "RequestLog"').catch(() => {});
        }
      }
    } finally {
      await vac.end().catch(() => {});
    }
  }

  if (INDEXES) {
    const idxClient = await openClient(directUrl(), 0);
    try {
      for (const [name, colsSql] of WANT_INDEXES) {
        const t0 = Date.now();
        await idxClient.query(
          'CREATE INDEX IF NOT EXISTS "' + name + '" ON "RequestLog"(' + colsSql + ")",
        );
        console.log("索引 " + name + " 就绪，" + ((Date.now() - t0) / 1000).toFixed(1) + "s");
      }
      await idxClient.query('analyze "RequestLog"');
    } finally {
      await idxClient.end().catch(() => {});
    }
  }

  const check = await openClient(databaseUrl(), 600000);
  try {
    const after = await stats(check);
    const { rows: afterCols } = await check.query(`
      select count(*) filter (where ${HEAVY_PREDICATE})::bigint as heavy,
             coalesce(sum(
               coalesce(pg_column_size("requestMessages"), 0)
               + coalesce(pg_column_size("responseMessage"), 0)
               + coalesce(pg_column_size("attemptDetails"), 0)
               + coalesce(pg_column_size("parameterOverrides"), 0)
               + coalesce(pg_column_size("errorDetail"), 0)), 0)::bigint as bytes
        from "RequestLog"`);
    console.log(
      "RequestLog: " + before.tbl + " → " + after.tbl +
      " | 整库: " + before.db + " → " + after.db,
    );
    console.log(
      "带详情字段: " + cols[0].heavy + " 行 → " + afterCols[0].heavy +
      " 行 | 行数据: " + cols[0].heavy_bytes + " → " + fmt(afterCols[0].bytes),
    );
    const { rows: idx2 } = await check.query(`
      select indexrelname as name, pg_size_pretty(pg_relation_size(indexrelid)) as sz
        from pg_stat_user_indexes where relname = 'RequestLog' order by indexrelname`);
    console.log("  " + idx2.map((i) => i.name + "(" + i.sz + ")").join(", "));
  } finally {
    await check.end().catch(() => {});
  }
})().catch(async (e) => {
  console.error("\n失败:", String(e.message || e).split("\n").slice(0, 5).join(" | "));
  process.exitCode = 1;
  // 出错时不关连接，node 会一直挂着等 pg socket；显式收尾让进程退出。
  await client?.end().catch(() => {});
});
