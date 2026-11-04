// 连通性排查：pg Pool vs 环境变量。
const fs = require("fs");
const { Pool } = require("pg");

function urlFromEnv() {
  if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, src: "process.env" };
  const raw = fs.readFileSync(".env", "utf8");
  const m = raw.match(/^DATABASE_URL="([^"]+)"/m);
  return m ? { url: m[1], src: ".env" } : { url: "", src: "none" };
}

(async () => {
  const { url, src } = urlFromEnv();
  console.log("DATABASE_URL 来源:", src, "| 长度:", url.length);
  if (!url) return;
  const masked = url.replace(/:\/\/[^@]*@/, "://***@");
  console.log("目标:", masked.split("?")[0]);
  for (const opts of [
    { label: "ssl default", cfg: { connectionString: url, connectionTimeoutMillis: 15000 } },
    { label: "ssl no verify", cfg: { connectionString: url, connectionTimeoutMillis: 15000, ssl: { rejectUnauthorized: false } } },
  ]) {
    const pool = new Pool(opts.cfg);
    try {
      const r = await pool.query("select current_user::text u, inet_server_addr()::text addr, current_setting('default_transaction_read_only') ro");
      console.log("[" + opts.label + "] OK:", JSON.stringify(r.rows[0]));
      await pool.end();
      return;
    } catch (e) {
      const inner = e.errors ? e.errors.map((x) => x.code + ":" + x.message).join(" | ") : "";
      console.log("[" + opts.label + "] FAIL:", e.constructor.name, "-", e.message, inner ? "→ " + inner : "");
      await pool.end().catch(() => {});
    }
  }
})();
