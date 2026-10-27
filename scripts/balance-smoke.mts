// 余额采样链路冒烟：建表 + sampleAll 节流 + snapshotBalance 聚合。
import { prisma } from "../src/lib/db";
import { sampleAll, snapshotBalance } from "../src/lib/balance";

async function main() {
  const probe = "__balance_smoke__";
  await prisma.balanceSample.deleteMany({ where: { uid: probe } });
  const n1 = await sampleAll([{ uid: probe, credits: 1000 }]);
  const n2 = await sampleAll([{ uid: probe, credits: 900 }]); // 30min 节流内 → 应被跳过
  const series = await snapshotBalance(0, { [probe]: "smoke" }, { [probe]: "cn" });
  const s = series.find((x) => x.uid === probe);
  console.log("added:", n1, n2, "current:", s?.current, "points:", s?.points.length, "daily:", s?.daily.length);
  if (n1 !== 1 || n2 !== 0 || !s || s.current !== 1000 || s.points.length !== 1) {
    throw new Error("smoke failed");
  }
  await prisma.balanceSample.deleteMany({ where: { uid: probe } });
  console.log("OK");
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
