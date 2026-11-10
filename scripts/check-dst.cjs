const {Client}=require("pg");
const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set DIRECT_URL or DATABASE_URL");
const c=new Client({connectionString,ssl:{rejectUnauthorized:false}});
(async()=>{
  await c.connect();
  for(const t of ["UsageEvent","ModelProbe","ModelHealthCheck","BalanceSample","TaskQueueItem"]){
    const r=await c.query('select count(*)::int n from "'+t+'"');
    console.log(t,r.rows[0].n);
  }
  const a=await c.query("select pid,state,wait_event,now()-query_start dur,left(query,80) q from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()");
  console.log(JSON.stringify(a.rows));
  await c.end();
})().catch(e=>{console.error(e.message);process.exit(1)});
