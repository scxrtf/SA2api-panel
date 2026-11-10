const {Client}=require("pg");
const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set DIRECT_URL or DATABASE_URL");
const c=new Client({connectionString,ssl:{rejectUnauthorized:false}});
(async()=>{
  await c.connect();
  await c.query(`
CREATE TABLE IF NOT EXISTS "BalanceSample" (
    "id" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "credits" BIGINT NOT NULL,
    "day" TEXT NOT NULL DEFAULT '',
    "first" BIGINT NOT NULL DEFAULT 0,
    "consumed" BIGINT NOT NULL DEFAULT 0,
    "gained" BIGINT NOT NULL DEFAULT 0,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BalanceSample_pkey" PRIMARY KEY ("id")
)`);
  await c.query('CREATE INDEX IF NOT EXISTS "BalanceSample_uid_at_idx" ON "BalanceSample"("uid", "at")');
  await c.query('CREATE INDEX IF NOT EXISTS "BalanceSample_at_idx" ON "BalanceSample"("at")');
  const r=await c.query("select to_regclass('\"BalanceSample\"') t");
  console.log("created:", r.rows[0].t);
  await c.end();
})().catch(e=>{console.error(e.message);process.exit(1)});
