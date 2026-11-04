// 只读验证：在事务里试删一行再回滚，证明 DELETE 是否被 25006 拒绝（零副作用）。
const fs = require("fs");
const { Client } = require("pg");

(async () => {
  const raw = fs.readFileSync(".env", "utf8");
  const url = process.env.DATABASE_URL || raw.match(/^DATABASE_URL="([^"]+)"/m)[1];
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("begin");
    const r = await c.query(
      `delete from "RequestLog" where id in (select id from "RequestLog" limit 1) returning id`,
    );
    console.log("DELETE 成功（未提交，回滚中）:", r.rowCount, "行");
    await c.query("rollback");
    console.log("已回滚，数据库未改动。");
  } catch (e) {
    console.log("DELETE 被拒:", e.code, "-", e.message);
    await c.query("rollback").catch(() => {});
  } finally {
    await c.end();
  }
})();
