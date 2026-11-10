const {Client}=require("pg");
const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set DIRECT_URL or DATABASE_URL");
const c=new Client({connectionString,ssl:{rejectUnauthorized:false}});
(async()=>{
  await c.connect();
  const r=await c.query("select tablename from pg_tables where schemaname='public' order by 1");
  console.log(r.rows.map(x=>x.tablename).join("\n"));
  await c.end();
})().catch(e=>{console.error(e.message);process.exit(1)});
