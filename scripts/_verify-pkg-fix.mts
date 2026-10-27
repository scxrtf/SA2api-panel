// _verify-pkg-fix.mts — 积分构成取数修复回归（真实上游 + 真实 DB，不依赖具体账号行）。
// 覆盖：死会话归类、正常号取数、脏 token 自愈、死号负缓存、网关 HTML 归一。
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_]+)\s*=\s*"?([^"]*)"?$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2];
}
const url = (p: string) => new URL("file:///" + path.join(root, p).replace(/\\/g, "/")).href;
const { withFreshAuth, classifySessionError, sanitizeUpstreamMessage } =
  await import(url("src/lib/accountSession.ts"));
const { creditPackages } = await import(url("src/lib/upstream/client.ts"));
const { getConfig } = await import(url("src/lib/config.ts"));
const { prisma } = await import(url("src/lib/db.ts"));

const cfg = await getConfig();
const shapeOf = (a: any) => ({
  uid: a.uid, nickname: a.nickname, realm: a.realm,
  accessToken: a.accessToken, refreshToken: a.refreshToken,
  expiresAt: Number(a.expiresAt), domain: a.domain,
  enterpriseId: a.enterpriseId, deviceToken: a.deviceToken,
});

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log("  PASS", name, detail); }
  else { fail++; console.log("  FAIL", name, detail); }
};

// ① 死会话：凭证整体无效（不落库的合成 uid，避免污染真实行）
console.log("\n[1] 会话已死（合成无效凭证）");
const DEAD = {
  uid: "00000000-0000-0000-0000-000000000000", nickname: "dead-probe", realm: "cn",
  accessToken: "invalid.access.token", refreshToken: "invalid-refresh-token",
  expiresAt: 0, domain: "", enterpriseId: "", deviceToken: "",
};
{
  let reason = "", msg = "";
  try {
    await withFreshAuth(cfg, DEAD as any, (s) => creditPackages(cfg, s));
  } catch (e) {
    reason = classifySessionError(e);
    msg = sanitizeUpstreamMessage(e instanceof Error ? e.message : String(e));
  }
  console.log("  reason =", reason, "| msg =", msg);
  check("归类为 session_dead", reason === "session_dead");
  check("文案无 HTML 标签", !/[<>]/.test(msg));
  check("文案可读", /12153|invalid|失效/.test(msg));
}

// ② 正常号：取到真实余额
console.log("\n[2] 正常号取数");
const live = (await prisma.account.findFirst({ orderBy: { createdAt: "asc" } }))!;
{
  const r = await withFreshAuth(cfg, shapeOf(live), (s) => creditPackages(cfg, s));
  console.log("  ", live.nickname, "packages =", r.packages.length, "remain =", r.remain, "size =", r.size);
  check("取到套餐包", r.packages.length > 0);
  check("剩余积分 > 0", r.remain > 0);
}

// ③ 脏 access token 自愈（模拟 DB 快照落后于上游）
console.log("\n[3] 脏 access token 自愈");
{
  const target = (await prisma.account.findFirst({ orderBy: { createdAt: "desc" } }))!;
  const beforeToken = target.accessToken;
  await prisma.account.update({ where: { uid: target.uid }, data: { accessToken: "deadbeef.invalid.token" } });
  const dirty = await prisma.account.findUnique({ where: { uid: target.uid } });
  let ok = false, detail = "";
  try {
    const r = await withFreshAuth(cfg, shapeOf(dirty as any), (s) => creditPackages(cfg, s));
    ok = r.packages.length > 0 && r.remain > 0;
    detail = "remain=" + r.remain;
  } catch (e) {
    detail = "抛错: " + (e instanceof Error ? e.message.slice(0, 70) : String(e));
  }
  const after = await prisma.account.findUnique({ where: { uid: target.uid } });
  console.log("  ", target.nickname, detail, "| token 已换新:", after?.accessToken !== "deadbeef.invalid.token");
  check("脏 token 下取数成功", ok, detail);
  check("新 token 已落库", after?.accessToken !== "deadbeef.invalid.token" && after?.accessToken !== beforeToken);
}

// ④ 负缓存：同一死号二次取数不再打上游
console.log("\n[4] 死号负缓存");
{
  const t0 = Date.now();
  let msg = "";
  try {
    await withFreshAuth(cfg, DEAD as any, (s) => creditPackages(cfg, s));
  } catch (e) {
    msg = sanitizeUpstreamMessage(e instanceof Error ? e.message : String(e));
  }
  const cost = Date.now() - t0;
  console.log("  二次耗时 =", cost + "ms | msg =", msg);
  check("命中负缓存（无上游往返）", cost < 200, cost + "ms");
  check("结论仍为需重新登录", /重新登录/.test(msg));
}

// ⑤ 网关 HTML 401 归一
console.log("\n[5] 网关 HTML 401 归一");
{
  const html = `<html> <head><title>401 Authorization Required</title></head> <body> <center><h1>401 Authorization Required</h1></center> <hr><center>openresty</center> <p><em>Powered by <a href="https://apisix.apache.org/">APISIX</a>.</em></p></body> </html>`;
  const out = sanitizeUpstreamMessage(html);
  console.log("  →", out);
  check("无标签", !/[<>]/.test(out));
  check("保留 401 语义", /401/.test(out));
}

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);
