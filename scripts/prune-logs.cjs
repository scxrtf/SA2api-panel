// 清理 RequestLog 中 7 天前的日志。
// 用法：
//   node scripts/prune-logs.cjs            # 只体检 + 估算，不删
//   node scripts/prune-logs.cjs --apply    # 真删（分批）+ VACUUM ANALYZE
//
// 为什么分批：1.5GB 的表一次性 DELETE 会攒出超长事务，pgbouncer/statement_timeout
// 都可能中途掐断，且死行回收更慢。每批 2000 行、每批提交，失败可续跑。
const { Client } = require("pg");
const fs = require("fs");

// node scripts/*.cjs 不会自动加载 .env（Prisma Client 会，纯 pg 不会），
// 这里显式补一次，避免 connectionString 落到默认 localhost 报 AggregateError。
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const raw = fs.readFileSync(".env", "utf8");
  const m = raw.match(/^DATABASE_URL="([^"]+)"/m);
  if (!m) throw new Error(".env 中找不到 DATABASE_URL");
  return m[1];
}

// Supabase 超额只读只是「库级默认参数 default_transaction_read_only=on」，
// 而实例仍是主库（pg_is_in_recovery=false），postgres 会话内 SET 覆盖合法。
// 直连 5432（session 模式）跑重活：VACUUM FULL 在事务模式下容易被 pooler 掐断。
function directUrl() {
  const raw = fs.readFileSync(".env", "utf8");
  const m = raw.match(/^DIRECT_URL="([^"]+)"/m);
  return m ? m[1] : databaseUrl();
}

const APPLY = process.argv.includes("--apply");
const RETENTION_DAYS = 7;
const BATCH = 2000;

function fmt(bytes) {
  const n = Number(bytes || 0);
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB";
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

let client = null;

(async () => {
  client = new Client({
    connectionString: databaseUrl(),
    statement_timeout: 600000,
  });
  await client.connect();
  // 会话级解除只读（Supabase 超额只读＝库级默认参数，主库上可覆盖）。
  // 失败说明是真正的只读副本/硬锁，后续写操作必然失败，直接停。
  await client.query("set default_transaction_read_only = off");

  const { rows: st } = await client.query(`
    select current_setting('default_transaction_read_only') as ro,
           current_setting('transaction_read_only') as tro,
           pg_is_in_recovery() as rec,
           pg_size_pretty(pg_database_size(current_database())) as db_size,
           pg_database_size(current_database()) as db_bytes,
           now() as now`);
  const ro = st[0].tro === "on";
  console.log(
    "数据库:", st[0].db_size, "| 会话只读:", ro ? "是" : "否（已解除）",
    "| 实例角色:", st[0].rec ? "只读副本" : "主库",
  );

  const { rows: tbl } = await client.query(`
    select n_live_tup::bigint as rows,
           pg_total_relation_size('"RequestLog"') as bytes,
           pg_size_pretty(pg_total_relation_size('"RequestLog"')) as pretty
      from pg_stat_user_tables where relname = 'RequestLog'`);
  if (tbl.length) console.log("RequestLog 当前:", tbl[0].rows, "行 /", tbl[0].pretty);

  // 7 天前的目标集合
  const { rows: target } = await client.query(`
    select count(*)::bigint as rows,
           coalesce(sum(pg_column_size(r.*)), 0)::bigint as payload_bytes
      from "RequestLog" r
     where at < now() - interval '${RETENTION_DAYS} days'`);
  const { rows: stay } = await client.query(`
    select count(*)::bigint as rows
      from "RequestLog"
     where at >= now() - interval '${RETENTION_DAYS} days'`);
  console.log(
    `待删（at < 7 天前）: ${target[0].rows} 行 / 行数据约 ${fmt(target[0].payload_bytes)}` +
    ` | 保留: ${stay[0].rows} 行`,
  );

  // count(*)::bigint 在 pg 里回的是字符串，"0" === 0 恒为 false，
  // 曾导致空集合时继续往下取 min(at)（null）而崩。统一转 Number。
  if (Number(target[0].rows) === 0) {
    console.log("没有 7 天前的日志，无需清理。");
    await client.end();
    return;
  }

  const { rows: range } = await client.query(`
    select min(at) as oldest, max(at) as newest
      from "RequestLog" where at < now() - interval '${RETENTION_DAYS} days'`);
  console.log("时间范围:", range[0].oldest.toISOString(), "→", range[0].newest.toISOString());

  if (ro || st[0].rec) {
    console.log(
      "\n无法写入（" + (st[0].rec ? "只读副本" : "只读默认参数未能覆盖") +
      "）：DELETE 会被 25006 拒绝，本次不做任何改动。",
    );
    await client.end();
    process.exitCode = 2;
    return;
  }

  if (!APPLY) {
    console.log("\n[体检模式] 未删除任何数据。确认无误后加 --apply 执行。");
    await client.end();
    return;
  }

  // 分批删除
  let deleted = 0;
  const startedAt = Date.now();
  for (;;) {
    const { rows } = await client.query(`
      delete from "RequestLog"
       where id in (
         select id from "RequestLog"
          where at < now() - interval '${RETENTION_DAYS} days'
          limit ${BATCH}
       )
       returning 1`);
    const n = rows.length;
    deleted += n;
    if (n > 0) {
      process.stdout.write(`\r  已删除 ${deleted} 行`);
    }
    if (n < BATCH) break;
  }
  console.log(`\n删除完成: ${deleted} 行，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  const { rows: mid } = await client.query(`
    select pg_size_pretty(pg_total_relation_size('"RequestLog"')) as pretty`);
  console.log("DELETE 后表占用（含死行）:", mid[0].pretty);

  // DELETE 只标记死行，文件不会变小 → 必须 VACUUM FULL 才真正归还磁盘。
  // 走直连 5432 + 无语句超时：VACUUM FULL 独占锁且重写整表，事务池化模式容易掐断。
  const vac = new Client({ connectionString: directUrl(), statement_timeout: 0, query_timeout: 0 });
  await vac.connect();
  await vac.query("set default_transaction_read_only = off");
  try {
    console.log("VACUUM FULL ANALYZE \"RequestLog\" ...（独占锁，期间该表不可用）");
    const vacStart = Date.now();
    await vac.query('vacuum (full, analyze) "RequestLog"');
    console.log("VACUUM FULL 完成，耗时 " + ((Date.now() - vacStart) / 1000).toFixed(1) + "s");
  } catch (e) {
    console.log("VACUUM FULL 失败（" + String(e.message).split("\n")[0] + "）→ 退化为普通 VACUUM");
    await vac.query('vacuum (analyze) "RequestLog"').catch(() => {});
  }
  await vac.end().catch(() => {});
  await client.end().catch(() => {});

  const check = new Client({ connectionString: databaseUrl(), statement_timeout: 600000 });
  await check.connect();
  await check.query("set default_transaction_read_only = off");
  const { rows: after } = await check.query(`
    select n_live_tup::bigint as rows,
           pg_size_pretty(pg_total_relation_size('"RequestLog"')) as pretty,
           pg_size_pretty(pg_database_size(current_database())) as db
      from pg_stat_user_tables where relname = 'RequestLog'`);
  console.log("RequestLog 现在:", after[0].rows, "行 /", after[0].pretty, "| 整库:", after[0].db);
  await check.end();
})().catch(async (e) => {
  console.error("\n失败:", String(e.message || e).split("\n").slice(0, 5).join(" | "));
  process.exitCode = 1;
  // 出错时不关连接，node 会一直挂着等 pg socket；显式收尾让进程退出。
  await client?.end().catch(() => {});
});
