const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
async function retry(fn, n = 5) {
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) {
      if (i === n - 1) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
}
(async () => {
  const account = await retry(() => p.account.count());
  const provider = await retry(() => p.provider.count());
  const apiKey = await retry(() => p.apiKey.count());
  const usageEvent = await retry(() => p.usageEvent.count());
  const modelHealthCheck = await retry(() => p.modelHealthCheck.count());
  const balanceSample = await retry(() => p.$queryRawUnsafe('SELECT count(*)::int AS c FROM "BalanceSample"'));
  console.log({ account, provider, apiKey, usageEvent, modelHealthCheck, balanceSample: balanceSample[0].c });
  const one = await retry(() => p.provider.findFirst());
  console.log("sample provider:", one && { id: one.id, name: one.name });
  await p.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
