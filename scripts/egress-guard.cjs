// RequestLog 对话字段的永久库级剥离。
//
// 作用：即使线上还跑着旧版本（仍带 REQUEST_LOG_DIALOG=1），写入时也会把
// requestMessages / responseMessage 置空，避免持续产生 80-145 KB/行的大字段。
//
// 用法：
//   node scripts/egress-guard.cjs           # 体检：触发器在不在
//   node scripts/egress-guard.cjs --apply    # 安装/更新触发器，并做一次回滚验证
//   node scripts/egress-guard.cjs --drop     # 卸载触发器与函数
//
// 验证方式：在事务里把最新一行的两列改成探针值，RETURNING 读回应为 null，随后 rollback。
// 不写业务数据、不留残留。
const { Client } = require("pg");
const fs = require("fs");
const path = require("path");

function envValue(key) {
  if (process.env[key]) return process.env[key];
  const raw = fs.readFileSync(".env", "utf8");
  const m = raw.match(new RegExp("^" + key + '="([^"]+)"', "m"));
  return m ? m[1] : null;
}

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const DROP = argv.includes("--drop");

const MIGRATION = path.join(
  __dirname,
  "..",
  "prisma",
  "migrations",
  "20261105120000_disable_request_log_dialog",
  "migration.sql",
);

const DROP_SQL = `
drop trigger if exists "requestlog_strip_dialog" on "RequestLog";
drop function if exists public.strip_request_log_dialog();
`;

async function open() {
  const url = envValue("DIRECT_URL") || envValue("DATABASE_URL");
  if (!url) throw new Error(".env 中找不到 DIRECT_URL / DATABASE_URL");
  const c = new Client({ connectionString: url, statement_timeout: 600000, query_timeout: 0 });
  await c.connect();
  await c.query("set default_transaction_read_only = off");
  return c;
}

async function status(c) {
  const { rows } = await c.query(`
    select t.tgname as trigger_name, p.proname as fn
      from pg_trigger t
      join pg_class cl on cl.oid = t.tgrelid
      left join pg_proc p on p.oid = t.tgfoid
     where cl.relname = 'RequestLog' and not t.tgisinternal`);
  return rows;
}

(async () => {
  const c = await open();
  try {
    if (DROP) {
      await c.query(DROP_SQL);
      console.log("已卸载触发器 requestlog_strip_dialog 与函数 strip_request_log_dialog()");
    } else if (APPLY) {
      const sql = fs.readFileSync(MIGRATION, "utf8");
      await c.query(sql);
      console.log("迁移已执行:", path.relative(process.cwd(), MIGRATION));
    }

    const rows = await status(c);
    const hit = rows.find((r) => r.trigger_name === "requestlog_strip_dialog");
    console.log("触发器:", hit ? "已安装（" + hit.fn + "）" : "未安装");

    if (APPLY && hit) {
      await c.query("begin");
      const { rows: probe } = await c.query(`
        update "RequestLog"
           set "requestMessages" = '{"probe":1}'::jsonb,
               "responseMessage" = '{"probe":1}'::jsonb
         where id = (select id from "RequestLog" order by "at" desc limit 1)
        returning "requestMessages" is null as rm_null,
                  "responseMessage" is null as resp_null`);
      await c.query("rollback");
      const r = probe[0];
      console.log(
        "回滚验证:",
        r ? (r.rm_null && r.resp_null ? "两列均被剥离（PASS）" : "未剥离（FAIL）") : "无返回行（表为空？）",
      );
    }

    const { rows: heavy } = await c.query(`
      select count(*)::int as n,
             coalesce(sum(pg_column_size("requestMessages") + pg_column_size("responseMessage")), 0)::bigint as b
        from "RequestLog"
       where "requestMessages" is not null or "responseMessage" is not null`);
    console.log("当前带对话字段:", heavy[0].n, "行 /", heavy[0].b, "B");
  } finally {
    await c.end().catch(() => {});
  }
})().catch(async (e) => {
  console.error("失败:", String(e.message || e).split("\n").slice(0, 4).join(" | "));
  process.exitCode = 1;
});
