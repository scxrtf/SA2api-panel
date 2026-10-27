// _scan-dead-accounts.mts — 逐号体检：区分「可自愈」「已死」「正常」，并导出死号备份。
// 只读 + 自愈（withFreshAuth 会把刷新成功的新 token 写回，不会破坏正常号）。
// 不删除任何行；删除动作由人工确认后另行执行。
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2];
}
const url = (p: string) => new URL("file:///" + path.join(root, p).replace(/\\/g, "/")).href;
const { withFreshAuth, classifySessionError, sanitizeUpstreamMessage } =
  await import(url("src/lib/accountSession.ts"));
const { creditPackages } = await import(url("src/lib/upstream/client.ts"));
const { getConfig } = await import(url("src/lib/config.ts"));
const { prisma } = await import(url("src/lib/db.ts"));

const cfg = await getConfig();
const rows = await prisma.account.findMany({
  orderBy: { createdAt: "asc" },
  include: { state: true },
});

type Verdict = "alive" | "healed" | "dead" | "unknown";
interface Item {
  uid: string; nickname: string; realm: string; verdict: Verdict;
  reason: string; remain: number; total: number; credits: number;
  lastUsedAt: string; okCount: number; msg: string;
  row: unknown;
}
const out: Item[] = [];

for (const a of rows) {
  const shape = {
    uid: a.uid, nickname: a.nickname, realm: a.realm,
    accessToken: a.accessToken, refreshToken: a.refreshToken,
    expiresAt: Number(a.expiresAt), domain: a.domain,
    enterpriseId: a.enterpriseId, deviceToken: a.deviceToken,
  };
  const before = a.accessToken;
  let verdict: Verdict = "unknown";
  let remain = 0, total = 0, msg = "", reason = "";
  try {
    const r = await withFreshAuth(cfg, shape, (s) => creditPackages(cfg, s));
    remain = r.remain; total = r.size;
    const after = await prisma.account.findUnique({ where: { uid: a.uid }, select: { accessToken: true } });
    // token 变了说明这次是「靠刷新救回来的」——属于可自愈，不是死号。
    verdict = after && after.accessToken !== before ? "healed" : "alive";
  } catch (e) {
    reason = classifySessionError(e);
    msg = sanitizeUpstreamMessage(e instanceof Error ? e.message : String(e));
    verdict = reason === "session_dead" ? "dead" : "unknown";
  }
  const lastUse = await prisma.usageEvent.findFirst({
    where: { uid: a.uid }, orderBy: { at: "desc" }, select: { at: true },
  });
  out.push({
    uid: a.uid, nickname: a.nickname, realm: a.realm, verdict, reason,
    remain, total, credits: Number(a.state?.credits ?? 0),
    lastUsedAt: lastUse?.at.toISOString().slice(0, 16) ?? "从未使用",
    okCount: await prisma.usageEvent.count({ where: { uid: a.uid, ok: true } }),
    msg,
    row: { account: a, state: a.state },
  });
}

// 控制台汇总
const tally = { alive: 0, healed: 0, dead: 0, unknown: 0 };
for (const it of out) tally[it.verdict]++;
console.log("账号总数", out.length, "→", JSON.stringify(tally));
console.log("\n序号 uid8     昵称          判定    余额快照  最近使用           说明");
out.forEach((it, i) => {
  console.log([
    String(i + 1).padStart(3),
    it.uid.slice(0, 8),
    (it.nickname || "-").padEnd(12),
    it.verdict.padEnd(6),
    String(it.credits).padStart(8),
    it.lastUsedAt.padEnd(18),
    String(it.okCount).padStart(2) + "ok",
    it.msg.slice(0, 60),
  ].join(" "));
});

// 死号备份（含完整凭证与状态行，便于原样恢复）
const dead = out.filter((it) => it.verdict === "dead");
const dir = path.join(root, "backup-dead-accounts");
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const file = path.join(dir, `dead-accounts-${stamp}.json`);
fs.writeFileSync(file, JSON.stringify({
  exportedAt: new Date().toISOString(),
  note: "删除前置备份：Account + AccountState 原样行；恢复用 prisma.account.create / accountState.create",
  count: dead.length,
  accounts: dead.map((d) => d.row),
}, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2), "utf8");
console.log("\n死号备份 →", file, "(" + dead.length + " 个)");
console.log("死号 uid 列表：");
console.log(dead.map((d) => d.uid).join("\n"));

await prisma.$disconnect();
