const fs = require("fs");
const url = fs.readFileSync(".env", "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
(async () => {
  const since = new Date(Date.now() - 72 * 3600_000);
  // 复刻修复后 usage 路由的查询形态
  const events = await p.usageEvent.findMany({ where: { at: { gte: since } }, orderBy: { id: "asc" } });
  console.log("usageEvent findMany OK, rows =", events.length);
  const logs = await p.requestLog.findMany({ where: { at: { gte: since } }, take: 5 });
  console.log("requestLog findMany OK, rows =", logs.length);
  const nicks = await p.account.findMany({ select: { uid: true, nickname: true } });
  console.log("account select OK, rows =", nicks.length);
  await p.$disconnect();
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
