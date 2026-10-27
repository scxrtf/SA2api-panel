const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient();
(async()=>{
  const since=new Date(Date.now()-24*3600*1000);
  const rows=await p.requestLog.findMany({where:{at:{gte:since}},select:{at:true,status:true,errKind:true,attempts:true,durationMs:true,model:true,uid:true}});
  const byHour={};
  for(const r of rows){const k=r.at.toISOString().slice(0,13);byHour[k]=byHour[k]||{};const kk=r.status+'|'+(r.errKind||'');byHour[k][kk]=(byHour[k][kk]||0)+1;}
  for(const k of Object.keys(byHour).sort())console.log(k,JSON.stringify(byHour[k]));
  console.log('--- 503|client detail (last 24h) ---');
  const b=rows.filter(r=>r.status===503&&r.errKind==='client').sort((a,b)=>a.at-b.at);
  console.log('count',b.length);
  for(const r of b.slice(-25)) console.log(r.at.toISOString(),'att',r.attempts,'dur',r.durationMs,r.model);
  await p.$disconnect();
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});

