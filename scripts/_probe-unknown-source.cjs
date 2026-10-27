// 临时只读诊断：定位请求日志表里 "unknown" 来自哪一列。
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

(async () => {
  const total = await p.requestLog.count();
  console.log("TOTAL", total);

  const kinds = await p.requestLog.groupBy({
    by: ["errKind"],
    _count: { _all: true },
  });
  console.log("ERR_KINDS", JSON.stringify(kinds, null, 1));

  const cols = ["model", "provider", "realm", "slot", "keyName", "path", "uid", "machineId"];
  for (const col of cols) {
    const n = await p.requestLog.count({
      where: { [col]: { contains: "unknown", mode: "insensitive" } },
    });
    console.log("COL", col, "contains unknown:", n);
  }

  const latest = await p.requestLog.findMany({
    orderBy: { id: "desc" },
    take: 10,
  });
  console.log("LATEST", JSON.stringify(latest, null, 1));
  await p.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
