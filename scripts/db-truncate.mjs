// 阶段3：TRUNCATE 释放物理空间 -> 关闭只读 -> 复查
// 用法: node scripts/db-truncate.mjs [--table RequestLog] [--yes]
import fs from "node:fs";
import pg from "pg";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const TABLE = val("--table", "RequestLog");

const env = Object.fromEntries(
  fs.readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"(.*)"$/, "$1")]; })
);

const client = new pg.Client({
  connectionString: process.env.DIRECT_URL || env.DIRECT_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 300000,
  query_timeout: 300000,
});

const one = async (sql, p) => (await client.query(sql, p)).rows[0];
const tryStep = async (label, fn) => {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`OK   (${Date.now() - t0}ms) ${label}${r !== undefined ? " -> " + JSON.stringify(r) : ""}`);
    return { ok: true, r };
  } catch (e) {
    console.log(`FAIL (${Date.now() - t0}ms) ${label} -> ${e.message}`);
    return { ok: false, e: e.message };
  }
};

const size = () => one(`
  select pg_size_pretty(pg_database_size(current_database())) db,
         pg_size_pretty(pg_total_relation_size('"${TABLE}"'::regclass)) tbl,
         (select count(*) from "${TABLE}") rows`);

try {
  await client.connect();
  await client.query("set session characteristics as transaction read write");
  await client.query("set default_transaction_read_only = off");

  console.log("[before]", JSON.stringify(await size()));

  if (!has("--yes")) {
    console.log("(no --yes) dry only.");
  } else {
    // TRUNCATE 立即换 relfilenode，旧文件立刻归还 OS，不产生死元组
    const ok = await tryStep(`truncate "${TABLE}"`, async () => {
      await client.query(`truncate table "${TABLE}"`);
      return "truncated";
    });

    if (!ok.ok) {
      // 退路：分批 DELETE（不还盘，但至少让 autovacuum 有机会）
      console.log("[fallback] 尝试只删索引外的小范围，观察空间");
    }

    console.log("[after truncate]", JSON.stringify(await size()));

    // 关只读（数据库级 + 角色级）
    const dbname = (await one("select current_database() d")).d;
    for (const sql of [
      `alter database "${dbname}" set default_transaction_read_only = off`,
      `alter role postgres in database "${dbname}" set default_transaction_read_only = off`,
      `alter role postgres set default_transaction_read_only = off`,
    ]) {
      await tryStep(sql, () => client.query(sql));
    }

    console.log("[settings]", JSON.stringify(await one(`
      select setconfig from pg_db_role_setting s join pg_database d on d.oid = s.setdatabase
       where d.datname = current_database()`)));
    console.log("[session ro]", JSON.stringify(await one("select current_setting('default_transaction_read_only') s")));
    console.log("[wal]", JSON.stringify(await one("select count(*) n, pg_size_pretty(sum(size)) sz from pg_ls_waldir()")));
    console.log("[final]", JSON.stringify(await size()));

    // 用新连接验证只读是否真的解除
    const c2 = new pg.Client({
      connectionString: process.env.DIRECT_URL || env.DIRECT_URL,
      ssl: { rejectUnauthorized: false },
    });
    await c2.connect();
    const chk = await c2.query("show default_transaction_read_only");
    console.log("[new connection default_transaction_read_only]", chk.rows[0]);
    const w = await c2.query("select 1 as ok");
    console.log("[new connection select]", w.rows[0]);
    await c2.end();
  }
} catch (e) {
  console.error("FATAL:", e.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
