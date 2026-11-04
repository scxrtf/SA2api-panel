// 阶段4：把本地 NDJSON 备份回灌到 RequestLog（TRUNCATE 之后重新写入保留窗口）
// 用法: node scripts/db-restore.mjs --in scripts/requestlog-keep-24h.ndjson [--batch 100] [--yes]
import fs from "node:fs";
import readline from "node:readline";
import pg from "pg";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const IN = val("--in", "scripts/requestlog-keep-24h.ndjson");
const BATCH = Number(val("--batch", "100"));

const env = Object.fromEntries(
  fs.readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"(.*)"$/, "$1")]; })
);

if (!fs.existsSync(IN)) {
  console.error("missing backup:", IN);
  process.exit(1);
}

const client = new pg.Client({
  connectionString: process.env.DIRECT_URL || env.DIRECT_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 180000,
  query_timeout: 240000,
});

const size = async () => (await client.query(`
  select pg_size_pretty(pg_database_size(current_database())) db,
         pg_size_pretty(pg_total_relation_size('"RequestLog"'::regclass)) tbl,
         (select count(*) from "RequestLog") rows`)).rows[0];

try {
  await client.connect();
  await client.query("set session characteristics as transaction read write");
  await client.query("set default_transaction_read_only = off");

  console.log("[before]", JSON.stringify(await size()));
  if (!has("--yes")) {
    console.log("(no --yes) dry only.");
    process.exit(0);
  }

  const rl = readline.createInterface({ input: fs.createReadStream(IN, "utf8"), crlfDelay: Infinity });

  let cols = null;
  let batch = [];
  let done = 0, failed = 0;

  const flush = async () => {
    if (!batch.length) return;
    const values = [];
    const rows = batch.map((obj, ri) => {
      const ph = cols.map((c, ci) => { values.push(obj[c] === undefined ? null : obj[c]); return `$${ri * cols.length + ci + 1}`; });
      return `(${ph.join(",")})`;
    });
    const sql = `insert into "RequestLog" (${cols.map((c) => `"${c}"`).join(",")}) values ${rows.join(",")} on conflict ("id") do nothing`;
    try {
      await client.query(sql, values);
      done += batch.length;
    } catch (e) {
      // 单行退化重试，避免整批丢
      for (const obj of batch) {
        try {
          const vs = [];
          const ph = cols.map((c, i) => { vs.push(obj[c] === undefined ? null : obj[c]); return `$${i + 1}`; });
          await client.query(
            `insert into "RequestLog" (${cols.map((c) => `"${c}"`).join(",")}) values (${ph.join(",")}) on conflict ("id") do nothing`,
            vs
          );
          done++;
        } catch (e2) {
          failed++;
          if (failed <= 5) console.log("  row fail:", e2.message.slice(0, 120));
        }
      }
    }
    batch = [];
    if (done % 500 === 0) console.log(`  restored ${done} (failed ${failed}) db=${(await size()).db}`);
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    if (!cols) {
      cols = Object.keys(obj);
      console.log("cols:", cols.length);
    }
    batch.push(obj);
    if (batch.length >= BATCH) await flush();
  }
  await flush();
  rl.close();

  console.log(`[restore] done=${done} failed=${failed}`);
  console.log("[after]", JSON.stringify(await size()));
  console.log("[wal]", JSON.stringify((await client.query("select count(*) n, pg_size_pretty(sum(size)) sz from pg_ls_waldir()")).rows[0]));
} catch (e) {
  console.error("FATAL:", e.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
