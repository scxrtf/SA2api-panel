const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient();
(async()=>{
  const rows=await p.requestLog.findMany({where:{status:{gte:400}},orderBy:{at:'desc'},take:60,select:{at:true,model:true,status:true,errKind:true,attempts:true,durationMs:true,keyName:true,path:true}});
  const agg={};
  for(const r of rows){const k=r.status+'|'+r.errKind; agg[k]=(agg[k]||0)+1;}
  console.log(agg);
  for(const r of rows.slice(0,25)) console.log([r.at.toISOString(),r.status,r.errKind,r.model,r.attempts,r.durationMs,r.keyName,r.path].join(' | '));
  await p.$disconnect();
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
