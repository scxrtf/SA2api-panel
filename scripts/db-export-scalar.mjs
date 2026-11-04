// 分批导出 RequestLog 的标量统计列（不含 4 个 JSON 大字段），走 at 索引避免排序/临时文件
// 用法: node scripts/db-export-scalar.mjs --hours 24 --out scripts/requestlog-scalar.ndjson [--export]
import fs from "node:fs";
import pg from "pg";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const HOURS = Number(val("--hours", "24"));
const OUT = val("--out", "scripts/requestlog-scalar.ndjson");
const STEP = Number(val("--step", "200"));

const JSON_COLS = new Set(["requestMessages", "responseMessage", "attemptDetails", "parameterOverrides"]);

const env = Object.fromEntries(
  fs.readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"(.*)"$/, "$1")]; })
);

const client = new pg.Client({
  connectionString: process.env.DIRECT_URL || env.DIRECT_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 90000,
  query_timeout: 120000,
});

const one = async (sql, p) => (await client.query(sql, p)).rows[0];

try {
  await client.connect();

  const allCols = (await client.query(`
    select column_name from information_schema.columns
     where table_schema='public' and table_name='RequestLog' order by ordinal_position`)).rows.map((r) => r.column_name);
  const cols = allCols.filter((c) => !JSON_COLS.has(c));
  console.log("all cols:", allCols.length, "scalar cols:", cols.length);
  console.log("scalars:", cols.join(","));

  const anchor = (await one(`select max("at") newest from "RequestLog"`)).newest;
  const from = new Date(new Date(anchor).getTime() - HOURS * 3600 * 1000).toISOString();
  console.log("anchor", anchor, "from", from);

  const n = (await one(`select count(*)::int n from "RequestLog" where "at" >= $1`, [from])).n;
  console.log("rows in window:", n);

  if (!has("--export")) { console.log("(no --export)"); process.exit(0); }

  const fd = fs.openSync(OUT, "w");
  let written = 0;
  const colList = cols.map((c) => `"${c}"`).join(",");

  for (let round = 0; round < 5000; round++) {
    const res = await client.query({
      text: `select ${colList} from "RequestLog"
              where "at" >= $1 and "at" <= $2
              order by "at"
              limit ${STEP} offset ${written}`,
      values: [from, anchor],
      rowMode: "array",
    });
    if (res.rows.length === 0) break;
    for (const row of res.rows) {
      const obj = {};
      cols.forEach((c, i) => { obj[c] = row[i]; });
      fs.writeSync(fd, JSON.stringify(obj) + "\n");
      written++;
    }
    if (round % 3 === 0) console.log(`  ${written}/${n}`);
    if (res.rows.length < STEP) break;
  }
  fs.closeSync(fd);

  const st = fs.statSync(OUT);
  console.log(`exported lines=${written} bytes=${st.size} (${(st.size / 1048576).toFixed(2)} MB) -> ${OUT}`);
} catch (e) {
  console.error("FATAL:", e.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
