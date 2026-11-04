// 阶段5：瘦身 ModelHealthCheck / UsageEvent 冗余，checkpoint 回收 WAL
import fs from "node:fs";
import pg from "pg";
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const DAYS = Number(val("--days", "3"));

const env = Object.fromEntries(
  fs.readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"(.*)"$/, "$1")]; })
);
const c = new pg.Client({ connectionString: process.env.DIRECT_URL || env.DIRECT_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 300000, query_timeout: 330000 });
const one = async (sql, p) => (await c.query(sql, p)).rows[0];
const size = () => one(`
  select pg_size_pretty(pg_database_size(current_database())) db,
    (select pg_size_pretty(pg_total_relation_size('"ModelHealthCheck"'::regclass))) mhc,
    (select pg_size_pretty(pg_total_relation_size('"UsageEvent"'::regclass))) ue,
    (select count(*) from "ModelHealthCheck") mhc_rows,
    (select count(*) from "UsageEvent") ue_rows,
    (select count(*) from "RequestLog") rl_rows`);

try {
  await c.connect();
  await c.query("set session characteristics as transaction read write");
  console.log("[before]", JSON.stringify(await size()));

  if (has("--execute")) {
    // ModelHealthCheck：删 N 天前（列名 checkedAt）
    const cols = (await c.query(`select column_name from information_schema.columns where table_schema='public' and table_name='ModelHealthCheck'`)).rows.map(r => r.column_name);
    const tcol = cols.find(n => /^(checkedAt|createdAt|at)$/.test(n));
    console.log("ModelHealthCheck time column:", tcol, "| cols:", cols.join(","));
    if (tcol) {
      let total = 0;
      for (let i = 0; i < 200; i++) {
        const r = await c.query(`delete from "ModelHealthCheck" where ctid in (
          select ctid from "ModelHealthCheck" where "${tcol}" < (now() - interval '${DAYS} days') limit 2000)`);
        total += r.rowCount || 0;
        if (!r.rowCount) break;
        process.stdout.write(`\r  mhc deleted ${total}`);
      }
      console.log(`\n[ModelHealthCheck] deleted=${total}`);
    }

    // RequestLog：删 7 天前（保留刚才回灌的窗口之外的老行，本来已清空）
    const rl = await c.query(`delete from "RequestLog" where "at" < (now() - interval '7 days')`);
    console.log(`[RequestLog] deleted=${rl.rowCount}`);

    await c.query(`vacuum (analyze) "ModelHealthCheck"`).catch(e => console.log("vacuum mhc:", e.message));
    console.log("[after vacuum]", JSON.stringify(await size()));

    // 触发 checkpoint，让 WAL 段可回收
    try {
      const cp = await c.query("checkpoint");
      console.log("[checkpoint]", cp.command);
    } catch (e) { console.log("[checkpoint] ", e.message); }
    await new Promise(r => setTimeout(r, 3000));
    console.log("[wal]", JSON.stringify(await one("select count(*) n, pg_size_pretty(sum(size)) sz from pg_ls_waldir()")));
    console.log("[final]", JSON.stringify(await size()));
  } else {
    console.log("(dry) 加 --execute 执行");
  }
} catch (e) {
  console.error("FATAL:", e.message);
  process.exitCode = 1;
} finally {
  await c.end().catch(() => {});
}
