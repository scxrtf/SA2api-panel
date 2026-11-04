// Egress 审计（只读）。回答三个问题：
//   1) 整库 / 各表各占多少，谁在撑体积；
//   2) RequestLog 里还有多少行带着对话 JSON（会被列表页/详情页读出去）；
//   3) 索引建了没有（缺索引 → 过滤退化成全表扫 → 扫出来的行全算 Egress）。
//
// 用法：node scripts/egress-audit.cjs
// 不加任何 --apply，脚本里没有任何写语句。
const { Client } = require("pg");
const fs = require("fs");

function url() {
  if (process.env.DIRECT_URL) return process.env.DIRECT_URL;
  const raw = fs.readFileSync(".env", "utf8");
  const m = raw.match(/^DIRECT_URL="([^"]+)"/m) || raw.match(/^DATABASE_URL="([^"]+)"/m);
  if (!m) throw new Error(".env 中找不到 DIRECT_URL / DATABASE_URL");
  return m[1];
}

function fmt(bytes) {
  const n = Number(bytes || 0);
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB";
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

let client = null;

(async () => {
  client = new Client({ connectionString: url(), statement_timeout: 300000 });
  await client.connect();
  const q = async (sql) => (await client.query(sql)).rows;

  const [head] = await q(`
    select pg_size_pretty(pg_database_size(current_database())) db,
           pg_size_pretty(pg_database_size(current_database())
             - coalesce((select sum(pg_database_size(datname)) from pg_database
                          where datname <> current_database()), 0)) db2,
           current_setting('default_transaction_read_only') ro,
           pg_is_in_recovery() rec`);
  console.log("整库:", head.db, "| 默认只读参数:", head.ro, "| 实例角色:", head.rec ? "只读副本" : "主库");

  console.log("\n[最大 8 张表]");
  const tables = await q(`
    select relname,
           pg_total_relation_size(c.oid) as bytes,
           pg_size_pretty(pg_total_relation_size(c.oid)) as pretty,
           (select n_live_tup from pg_stat_user_tables s where s.relid = c.oid) as rows
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
     order by bytes desc limit 8`);
  for (const t of tables) {
    console.log(`  ${t.relname.padEnd(24)} ${String(t.pretty).padStart(9)}  rows=${t.rows ?? "?"}`);
  }

  console.log("\n[RequestLog 分代]");
  const [gen] = await q(`
    select count(*)::bigint total,
           count(*) filter (where at < now() - interval '3 days')::bigint d3,
           count(*) filter (where at < now() - interval '6 hours')::bigint h6,
           count(*) filter (where at < now() - interval '6 hours'
                              and ("requestMessages" is not null or "responseMessage" is not null
                                or "attemptDetails" is not null or "parameterOverrides" is not null
                                or coalesce("errorDetail",'') <> ''))::bigint h6_heavy,
           count(*) filter (where at >= now() - interval '24 hours'
                               and ("requestMessages" is not null or "responseMessage" is not null
                                 or "attemptDetails" is not null or "parameterOverrides" is not null
                                 or coalesce("errorDetail",'') <> ''))::bigint h24_heavy,
           pg_size_pretty(coalesce(sum(case when at >= now() - interval '24 hours'
                    then coalesce(pg_column_size("requestMessages"),0)
                       + coalesce(pg_column_size("responseMessage"),0)
                       + coalesce(pg_column_size("attemptDetails"),0)
                       + coalesce(pg_column_size("parameterOverrides"),0)
                    else 0 end),0)::bigint) h24_bytes,
           pg_size_pretty(coalesce(sum(
                       coalesce(pg_column_size("requestMessages"),0)
                       + coalesce(pg_column_size("responseMessage"),0)
                       + coalesce(pg_column_size("attemptDetails"),0)
                       + coalesce(pg_column_size("parameterOverrides"),0)),0)::bigint) reclaim
      from "RequestLog"`);
  console.log(`  总行数 ${gen.total} | >3天 ${gen.d3} | >6小时 ${gen.h6} | 其中仍带大字段 ${gen.h6_heavy}`);
  console.log(`  24h 内仍带大字段 ${gen.h24_heavy} 行 / ${gen.h24_bytes}（保留窗口的部分）`);
  console.log(`  全部大字段 ${gen.reclaim}（清空 + VACUUM FULL 后可还给磁盘，含 24h 内）`);

  console.log("\n[RequestLog 索引]");
  const idx = await q(`
    select indexrelname as name, pg_size_pretty(pg_relation_size(indexrelid)) sz,
           coalesce(idx_scan, 0) scans
      from pg_stat_user_indexes where relname = 'RequestLog' order by indexrelname`);
  if (!idx.length) console.log("  （无）");
  for (const i of idx) console.log(`  ${i.name}  ${i.sz}  scans=${i.scans}`);

  const want = ["RequestLog_status_at_idx", "RequestLog_errKind_at_idx",
                "RequestLog_model_at_idx", "RequestLog_keyName_at_idx"];
  const have = new Set(idx.map((i) => i.name));
  const missing = want.filter((n) => !have.has(n));
  console.log(missing.length ? `  缺: ${missing.join(", ")}` : "  4 条 Egress 索引齐全");

  console.log("\n[RequestLog 列体积（活数据，不含膨胀）]");
  const [cols] = await q(`
    select count(*)::bigint total,
           pg_size_pretty(sum(pg_column_size(t.*))::bigint) live,
           pg_size_pretty(sum(coalesce(pg_column_size("requestMessages"),0))::bigint) rm,
           pg_size_pretty(sum(coalesce(pg_column_size("responseMessage"),0))::bigint) resp,
           pg_size_pretty(sum(coalesce(pg_column_size("attemptDetails"),0))::bigint) att,
           pg_size_pretty(sum(coalesce(pg_column_size("parameterOverrides"),0))::bigint) po,
           pg_size_pretty(sum(coalesce(pg_column_size("errorDetail"),0))::bigint) err,
           count(*) filter (where "requestMessages" is not null)::bigint rm_rows,
           count(*) filter (where "responseMessage" is not null)::bigint resp_rows,
           count(*) filter (where "attemptDetails" is not null)::bigint att_rows,
           count(*) filter (where "parameterOverrides" is not null)::bigint po_rows,
           count(*) filter (where coalesce("errorDetail",'') <> '')::bigint err_rows
      from "RequestLog" t`);
  console.log(`  活行 ${cols.total} | 活数据 ${cols.live}`);
  console.log(`  requestMessages ${cols.rm} (${cols.rm_rows} 行) | responseMessage ${cols.resp} (${cols.resp_rows} 行)`);
  console.log(`  attemptDetails ${cols.att} (${cols.att_rows} 行) | parameterOverrides ${cols.po} (${cols.po_rows} 行)`);
  console.log(`  errorDetail ${cols.err} (${cols.err_rows} 行)`);

  console.log("\n[RequestLog 膨胀]");
  const [bloat] = await q(`
    select n_live_tup, n_dead_tup, seq_scan, idx_scan,
           pg_size_pretty(pg_relation_size(c.oid)) heap,
           pg_size_pretty(pg_total_relation_size(c.oid)) total,
           last_vacuum, last_autovacuum
      from pg_stat_user_tables s join pg_class c on c.oid = s.relid
     where s.relname = 'RequestLog'`);
  console.log(`  活元组 ${bloat.n_live_tup} | 死元组 ${bloat.n_dead_tup} | 堆 ${bloat.heap} | 含索引 ${bloat.total}`);
  console.log(`  seq_scan ${bloat.seq_scan} | idx_scan ${bloat.idx_scan}`);
  console.log(`  最近 vacuum: ${bloat.last_vacuum ?? "-"} | autovacuum: ${bloat.last_autovacuum ?? "-"}`);

  console.log("\n[Top 8 最大行]");
  const top = await q(`
    select id, at::text as at,
           pg_size_pretty(pg_column_size(t.*)::bigint) sz,
           pg_column_size("requestMessages") rm,
           pg_column_size("responseMessage") resp,
           pg_column_size("attemptDetails") att,
           pg_column_size("errorDetail") err
      from "RequestLog" t order by pg_column_size(t.*)::bigint desc limit 8`);
  for (const r of top) {
    console.log(`  ${String(r.id).slice(0, 10)} ${r.at}Z ${r.sz}  rm=${r.rm ?? 0} resp=${r.resp ?? 0} att=${r.att ?? 0} err=${r.err ?? 0}`);
  }

  console.log("\n[TOAST / WAL]");
  const [t] = await q(`
    select pg_size_pretty(pg_total_relation_size(c.reltoastrelid)) toast
      from pg_class c
     where c.oid = to_regclass('public."RequestLog"') and c.reltoastrelid <> 0`);
  console.log("  RequestLog TOAST:", t.toast ?? "(无)");
  const [w] = await q(`select count(*) n, pg_size_pretty(sum(size)) sz from pg_ls_waldir()`);
  console.log(`  WAL 文件 ${w.n} 个 / ${w.sz}`);
  await client.end();
})().catch(async (e) => {
  console.error("\n失败:", String(e.message || e).split("\n").slice(0, 5).join(" | "));
  process.exitCode = 1;
  await client?.end().catch(() => {});
});
