const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient();
(async()=>{
  const rows=await p.usageEvent.findMany({where:{at:{gte:new Date('2026-10-23T07:05:00Z'),lte:new Date('2026-10-23T07:16:00Z')}},orderBy:{at:'asc'}});
  console.log('count',rows.length);
  for(const r of rows) console.log([r.at.toISOString(),r.uid,r.model,r.realm,r.provider,r.ok,r.errKind,r.latencyMs,r.keyName,r.modelRate].join(' | '));
  await p.$disconnect();
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
