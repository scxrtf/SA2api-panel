// 临时只读诊断：来源 IP / 其余展示列是否出现 "unknown"。
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

(async () => {
  for (const col of ["clientIp", "ua"]) {
    const count = await p.requestLog.count({
      where: { [col]: { contains: "unknown", mode: "insensitive" } },
    });
    console.log("COUNT", col, count);

    const rows = await p.requestLog.findMany({
      where: { [col]: { contains: "unknown", mode: "insensitive" } },
      select: { id: true, at: true, status: true, clientIp: true, ua: true, errKind: true, model: true },
      orderBy: { id: "desc" },
      take: 5,
    });
    console.log("ROWS", col, JSON.stringify(rows, null, 1));
  }

  const ips = await p.requestLog.groupBy({
    by: ["clientIp"],
    _count: { _all: true },
    orderBy: { _count: { clientIp: "desc" } },
    take: 20,
  });
  console.log("TOP_IPS", JSON.stringify(ips, null, 1));
  await p.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
