// 临时诊断：列出账号凭据概况（不打印 token 明文）
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const rows = await p.account.findMany({ orderBy: { createdAt: 'asc' } });
  console.log('accounts =', rows.length);
  for (const a of rows) {
    const exp = Number(a.expiresAt) || 0;
    const now = Math.floor(Date.now() / 1000);
    console.log([
      a.uid,
      'nick=' + JSON.stringify(a.nickname),
      a.realm,
      'ent=' + JSON.stringify(a.enterpriseId || ''),
      'atLen=' + (a.accessToken || '').length,
      'rtLen=' + (a.refreshToken || '').length,
      'expiresAt=' + exp,
      'expIn=' + (exp ? exp - now : 'NA') + 's',
      'disabled=' + a.disabled,
      'domain=' + JSON.stringify(a.domain || ''),
      'dtLen=' + (a.deviceToken || '').length,
      'created=' + a.createdAt.toISOString(),
    ].join(' | '));
  }
  await p.$disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
