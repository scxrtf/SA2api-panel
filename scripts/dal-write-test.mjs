// DAL 写链路验证：create / createMany / update / findMany / count / deleteMany 全走 PostgREST。
// 用 BalanceSample 做靶标（无 FK 依赖），测完清理，零残留。
import { config } from "dotenv";
config();
process.env.USE_CLOUDBASE_REST = "1";
const { prisma } = await import("../src/lib/db.ts");

const log = (...a) => console.log(...a);

try {
  // 1. create：cuid 主键应由 DAL 生成
  const r1 = await prisma.balanceSample.create({
    data: { uid: "dal-test", credits: 100n, consumed: 10n, gained: 0n },
  });
  log("E1 create ok, id =", r1.id, "| typeof credits =", typeof r1.credits, "| at instanceof Date =", r1.at instanceof Date);

  // 2. createMany
  const r2 = await prisma.balanceSample.createMany({
    data: [
      { uid: "dal-test", credits: 200n, consumed: 20n, gained: 0n },
      { uid: "dal-test", credits: 300n, consumed: 30n, gained: 0n },
    ],
  });
  log("E2 createMany ok, count =", r2.count);

  // 3. update
  const r3 = await prisma.balanceSample.update({
    where: { id: r1.id },
    data: { consumed: 99n },
  });
  log("E3 update ok, consumed =", r3.consumed.toString());

  // 4. findMany + count
  const rows = await prisma.balanceSample.findMany({ where: { uid: "dal-test" } });
  const cnt = await prisma.balanceSample.count({ where: { uid: "dal-test" } });
  log("E4 findMany =", rows.length, "| count =", cnt);
} finally {
  const del = await prisma.balanceSample.deleteMany({ where: { uid: "dal-test" } });
  log("E5 cleanup deleteMany =", del.count);
}
