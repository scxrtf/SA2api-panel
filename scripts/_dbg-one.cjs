const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient();
(async()=>{
  const row=await p.requestLog.findUnique({where:{id:'cmvkmp1fd0054mn1th1jmslgx'}});
  console.log(JSON.stringify(row,null,1));
  const near=await p.requestLog.findMany({where:{model:'cn:kimi-k3-1'},orderBy:{at:'desc'},take:12});
  console.log('--- recent kimi ---');
  for(const r of near) console.log([r.at.toISOString(),r.status,r.errKind,r.attempts,r.durationMs,r.ttfbMs,r.keyName,r.slot,r.uid,r.realm,r.provider,r.path].join(' | '));
  await p.$disconnect();
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
