const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient();
(async()=>{
  const accts=await p.account.findMany({where:{realm:'cn'},select:{uid:true,nickname:true,expiresAt:true,updatedAt:true,accessToken:true,refreshToken:true,state:true}});
  const now=Math.floor(Date.now()/1000);
  for(const a of accts){
    console.log([a.uid.slice(0,8), a.nickname, 'exp='+a.expiresAt, 'in='+((Number(a.expiresAt)-now)/3600).toFixed(2)+'h',
      'hasAT='+(a.accessToken? a.accessToken.length:0), 'hasRT='+(a.refreshToken? a.refreshToken.length:0),
      'upd='+a.updatedAt.toISOString(),
      'disabled='+(a.state?.disabled??null), 'paused='+(a.state?.paused??null), 'sessionDead='+(a.state?.sessionDead??null),
      'strikes='+(a.state?.sessionStrikes??null), 'coolUntil='+(a.state?.cooldownUntil??null), 'reason='+(a.state?.cooldownReason??'')].join(' | '));
  }
  await p.$disconnect();
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
