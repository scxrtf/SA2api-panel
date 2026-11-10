// Supabase -> Prisma Postgres 全量数据搬运（一次性）。
// 用法: node scripts/migrate-supabase-to-prisma.cjs
// 策略: 按表 truncate + 全量 INSERT（拷贝语义，新库为目标权威）。
//       带行数校验；某表失败立即中止并报表名，重跑幂等。
const { Client } = require("pg");

const SRC = process.env.SRC_URL;
const DST = process.env.DST_URL;
if (!SRC || !DST) throw new Error("Set SRC_URL and DST_URL before running the migration");

// 依赖顺序：先父后子；_prisma_migrations 由 migrate deploy 生成，不搬。
const TABLES = [
  "Account",
  "AccountState",
  "ApiKey",
  "Provider",
  "Setting",
  "ModelCooldown",
  "ModelCost",
  "StickySession",
  "MachineKeyAuthorization",
  "LoginSession",
  "UsageEvent",
  "ModelProbe",
  "ModelHealthCheck",
  "BalanceSample",
  "TaskQueueItem",
];

const BATCH = 1000;
const MAX_RETRIES = 5;

async function newSrc() {
  const c = new Client({ connectionString: SRC, keepAlive: true, statement_timeout: 0 });
  await c.connect();
  return c;
}

async function main() {
  const dst = new Client({ connectionString: DST });
  await dst.connect();
  let src = await newSrc();

  async function srcQuery(sql, params) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await src.query(sql, params);
      } catch (e) {
        if (attempt === MAX_RETRIES) throw e;
        console.log(`src reconnect: ${e.message}`);
        try { await src.end(); } catch {}
        src = await newSrc();
      }
    }
  }
  try {
    for (const t of TABLES) {
      const cols = await dst.query(
        `select column_name, data_type from information_schema.columns
          where table_schema='public' and table_name=$1 order by ordinal_position`, [t]);
      if (!cols.rows.length) throw new Error(`target table missing: ${t}`);
      const names = cols.rows.map((r) => `"${r.column_name}"`);

      let offset = 0;
      let copied = 0;
      let truncated = false;
      for (;;) {
        const rows = await srcQuery(
          `select ${names.join(",")} from "${t}" order by 1 limit $1 offset $2`,
          [BATCH, offset]);
        if (!rows.rows.length) break;
        if (!truncated) { await dst.query(`truncate table "${t}" cascade`); truncated = true; }
        const params = [];
        const values = rows.rows.map((row, i) =>
          `(${cols.rows.map((c, j) => `$${i * names.length + j + 1}` + (c.data_type === "jsonb" || c.data_type === "json" ? "::jsonb" : "")).join(",")})`);
        for (const row of rows.rows) {
          for (const c of cols.rows) params.push(row[c.column_name]);
        }
        await dst.query(`insert into "${t}" (${names.join(",")}) values ${values.join(",")}`, params);
        copied += rows.rows.length;
        offset += rows.rows.length;
        process.stdout.write(`  ${t}: ${copied} rows\r`);
      }
      const a = await srcQuery(`select count(*)::int as n from "${t}"`);
      const b = await dst.query(`select count(*)::int as n from "${t}"`);
      const ok = a.rows[0].n === b.rows[0].n;
      console.log(`${ok ? "OK  " : "FAIL"} ${t}: src=${a.rows[0].n} dst=${b.rows[0].n} copied=${copied}`);
      if (!ok) throw new Error(`count mismatch on ${t}`);
    }
    console.log("ALL TABLES MIGRATED");
  } finally {
    await src.end();
    await dst.end();
  }
}

main().catch((e) => { console.error("MIGRATION FAILED:", e.message); process.exit(1); });
