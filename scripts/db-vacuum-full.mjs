// VACUUM FULL 指定表，真正把文件还给磁盘
// 用法: node scripts/db-vacuum-full.mjs "ModelHealthCheck" "UsageEvent"
import fs from "node:fs";
import pg from "pg";

const tables = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const env = Object.fromEntries(
  fs.readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"(.*)"$/, "$1")]; })
);
const c = new pg.Client({ connectionString: process.env.DIRECT_URL || env.DIRECT_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 600000, query_timeout: 660000 });
const one = async (sql) => (await c.query(sql)).rows[0];
const size = () => one(`
  select pg_size_pretty(pg_database_size(current_database())) db,
    pg_size_pretty(pg_total_relation_size('"RequestLog"'::regclass)) reqlog,
    pg_size_pretty(pg_total_relation_size('"ModelHealthCheck"'::regclass)) mhc,
    pg_size_pretty(pg_total_relation_size('"UsageEvent"'::regclass)) ue`);

try {
  await c.connect();
  await c.query("set session characteristics as transaction read write");
  console.log("[before]", JSON.stringify(await size()));
  for (const t of tables) {
    const t0 = Date.now();
    try {
      await c.query(`vacuum (full, analyze) "${t}"`);
      console.log(`OK ${t} (${Date.now() - t0}ms)`);
    } catch (e) {
      console.log(`FAIL ${t}: ${e.message}`);
    }
    console.log("  ->", JSON.stringify(await size()));
  }
  console.log("[after]", JSON.stringify(await size()));
  console.log("[wal]", JSON.stringify(await one("select count(*) n, pg_size_pretty(sum(size)) sz from pg_ls_waldir()")));
} catch (e) {
  console.error("FATAL:", e.message);
  process.exitCode = 1;
} finally {
  await c.end().catch(() => {});
}
