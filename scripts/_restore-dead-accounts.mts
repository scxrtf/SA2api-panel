// _restore-dead-accounts.mts — 从删除前备份恢复账号行（Account + AccountState）。
// 用法：
//   tsx scripts/_restore-dead-accounts.mts <backup.json>            # 实恢复
//   tsx scripts/_restore-dead-accounts.mts <backup.json> --dry-run  # 只校验结构，不写库
// 幂等：已存在的 uid 跳过，不覆盖现有凭证（避免把线上新 token 覆盖成旧值）。
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
const dryRun = process.argv.includes("--dry-run");
if (!backupFile || !fs.existsSync(backupFile)) {
  console.error("用法: tsx scripts/_restore-dead-accounts.mts <backup.json> [--dry-run]");
  process.exit(2);
}
const backup = JSON.parse(fs.readFileSync(backupFile, "utf8")) as {
  accounts: { account: Record<string, any>; state?: Record<string, any> | null }[];
};

// 备份里 BigInt 字段被序列化成字符串，恢复时逐字段还原。
const ACCOUNT_BIGINT = ["expiresAt"];
const ACCOUNT_DATE = ["createdAt", "updatedAt"];
const STATE_BIGINT = [
  "credits", "total", "expiring", "earliestAt", "earliestRemain", "disabledAt",
  "degradeUntil", "cooldownUntil", "breakerUntil", "lastUsed", "usedSeq", "balanceAt",
];
const STATE_DATE = ["updatedAt"];

function shapeAccount(raw: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "state") continue; // 关联对象单独写
    if (ACCOUNT_BIGINT.includes(k)) out[k] = BigInt(v ?? 0);
    else if (ACCOUNT_DATE.includes(k)) out[k] = new Date(v);
    else out[k] = v;
  }
  return out;
}
function shapeState(raw: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (STATE_BIGINT.includes(k)) out[k] = BigInt(v ?? 0);
    else if (STATE_DATE.includes(k)) out[k] = new Date(v);
    else out[k] = v;
  }
  return out;
}

let restored = 0, skipped = 0, failed = 0;
for (const item of backup.accounts) {
  const acct = shapeAccount(item.account);
  const state = item.state ?? item.account.state ?? null;
  const exists = await prisma.account.findUnique({ where: { uid: acct.uid }, select: { uid: true } });
  if (exists) {
    skipped++;
    console.log("SKIP", acct.uid, acct.nickname, "（已存在）");
    continue;
  }
  if (dryRun) {
    restored++;
    console.log("DRY ", acct.uid, acct.nickname, "state=", state ? "yes" : "no",
      "expiresAt=", typeof acct.expiresAt);
    continue;
  }
  try {
    await prisma.account.create({ data: acct });
    if (state) await prisma.accountState.create({ data: shapeState(state) });
    restored++;
    console.log("OK  ", acct.uid, acct.nickname);
  } catch (e) {
    failed++;
    console.log("FAIL", acct.uid, e instanceof Error ? e.message.slice(0, 120) : String(e));
  }
}

console.log(`\n${dryRun ? "[dry-run] " : ""}恢复 ${restored} / 跳过 ${skipped} / 失败 ${failed} / 共 ${backup.accounts.length}`);
await prisma.$disconnect();
process.exit(failed === 0 ? 0 : 1);
