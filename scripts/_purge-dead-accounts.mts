// _purge-dead-accounts.mts — 按备份清单删除已确认的死号（级联清理状态行）。
// 清单来源 = 备份 JSON 的 accounts[].account.uid，保证「删的就是备份过的」。
// 分批删除（每批 ≤8）+ 每批校验：账号数严格递减、已删 uid 的级联行清零、审计表不变。
// 可续跑：已不存在的 uid 记 SKIP，不视为失败。
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_]+)\s*=\s*"?([^"]*)"?$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2];
}
const url = (p: string) => new URL("file:///" + path.join(root, p).replace(/\\/g, "/")).href;
const { prisma } = await import(url("src/lib/db.ts"));

const backupFile = process.argv[2];
if (!backupFile || !fs.existsSync(backupFile)) {
  console.error("用法: tsx scripts/_purge-dead-accounts.mts <backup-json>");
  process.exit(2);
}
const backup = JSON.parse(fs.readFileSync(backupFile, "utf8")) as {
  accounts: { account: { uid: string; nickname: string } }[];
};
const nickOf = new Map(backup.accounts.map((a) => [a.account.uid, a.account.nickname]));
const targets = [...nickOf.keys()];
console.log("备份清单:", targets.length, "个 →", path.basename(backupFile));

const count = async () => ({
  account: await prisma.account.count(),
  state: await prisma.accountState.count(),
  cooldown: await prisma.modelCooldown.count(),
  cost: await prisma.modelCost.count(),
  sticky: await prisma.stickySession.count(),
  usage: await prisma.usageEvent.count(),
  reqlog: await prisma.requestLog.count(),
});
const before = await count();
console.log("删除前:", JSON.stringify(before));

const BATCH = 8;
const report: string[] = [];
const gone: string[] = [];
let deleted = 0;
let skipped = 0;

for (let i = 0; i < targets.length; i += BATCH) {
  const batch = targets.slice(i, i + BATCH);
  for (const uid of batch) {
    const nick = nickOf.get(uid) ?? "";
    const exists = await prisma.account.findUnique({ where: { uid }, select: { uid: true } });
    if (!exists) {
      skipped++;
      report.push(["SKIP", uid, nick + "（已不存在）"].join(" | "));
      continue;
    }
    try {
      await prisma.account.delete({ where: { uid } });
      deleted++;
      gone.push(uid);
      report.push(["OK  ", uid, nick].join(" | "));
    } catch (e) {
      report.push(["FAIL", uid, e instanceof Error ? e.message : String(e)].join(" | "));
    }
  }
  const c = await count();
  console.log(`第 ${i / BATCH + 1} 批（${batch.length} 个）后:`, JSON.stringify(c), "| 剩余账号 =", c.account);
  if (c.account !== before.account - deleted) {
    console.error("!! 账号数与预期不符（期望", before.account - deleted, "实际", c.account, "），中止");
    break;
  }
  // 只对「已删除」的 uid 检查级联残留（未删的账号当然还有状态行）。
  const orphanState = await prisma.accountState.count({ where: { uid: { in: gone } } });
  const orphanCd = await prisma.modelCooldown.count({ where: { uid: { in: gone } } });
  const orphanCost = await prisma.modelCost.count({ where: { uid: { in: gone } } });
  const orphanSticky = await prisma.stickySession.count({ where: { uid: { in: gone } } });
  if (orphanState + orphanCd + orphanCost + orphanSticky !== 0) {
    console.error("!! 级联残留 state/cooldown/cost/sticky =",
      orphanState, orphanCd, orphanCost, orphanSticky, "中止");
    break;
  }
}

const after = await count();
console.log("\n删除结果:", deleted, "个新删 /", skipped, "个已是删除态 / 共", targets.length);
console.log("删除后:", JSON.stringify(after));
console.log("审计表不变:", before.usage === after.usage && before.reqlog === after.reqlog
  ? "YES（UsageEvent / RequestLog 历史保留）" : "NO !!");

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.join(path.dirname(backupFile), `purge-report-${stamp}.txt`);
fs.writeFileSync(out, [
  "死号清理报告",
  "时间: " + new Date().toISOString(),
  "备份: " + path.basename(backupFile),
  "新删: " + deleted + "，已删除态跳过: " + skipped + "，清单共 " + targets.length,
  "删除前: " + JSON.stringify(before),
  "删除后: " + JSON.stringify(after),
  "",
  ...report,
].join("\n"), "utf8");
console.log("报告 →", out);

const left = await prisma.account.findMany({ select: { uid: true, nickname: true } });
console.log("存活账号:", left.length, "→", left.map((a) => a.nickname || a.uid.slice(0, 8)).join(" / "));
await prisma.$disconnect();
process.exit(deleted + skipped === targets.length ? 0 : 1);
