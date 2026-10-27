// _fix-dead-accounts: 一次性体检并隔离「access token 被上游吊销」的死号。
// 判定：上游 401（auth_expired）→ 刷新 refreshToken 也失败（通常 12153）→ 禁用。
// 仅供运维一次性使用；日常由 chat.ts 的 401 自愈路径自动完成同样处置。
// 重新登录（面板「添加账号」）会 revive，禁用可逆。
import { PrismaClient } from "@prisma/client";
import { getConfig } from "../src/lib/config";
import { chatStream, refreshToken } from "../src/lib/upstream/client";
import * as pool from "../src/lib/pool";
import { classify, UpstreamError } from "../src/lib/upstream/errors";

const p = new PrismaClient();
const model = process.argv[2] ?? "kimi-k3-1";
const dry = process.argv.includes("--dry");

(async () => {
  const cfg = await getConfig();
  const accts = await p.account.findMany({
    where: { realm: "cn", accessToken: { not: "" } },
    include: { state: true },
    orderBy: { updatedAt: "desc" },
  });
  let healthy = 0, dead = 0, other = 0, skipped = 0;
  for (const a of accts) {
    if (a.state?.disabled) { skipped++; continue; }
    const auth = {
      uid: a.uid, nickname: a.nickname, realm: a.realm, accessToken: a.accessToken,
      refreshToken: a.refreshToken, expiresAt: Number(a.expiresAt), domain: a.domain,
      enterpriseId: a.enterpriseId, deviceToken: a.deviceToken,
    } as any;
    const body = JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hi" }] });
    let note = "";
    try {
      const r = await chatStream(cfg, auth, body, "", { conversationID: "check-" + Date.now(), conversationRequestID: "", traceID: "" });
      if (r.body) { const rd = r.body.getReader(); try { await rd.read(); } finally { await rd.cancel(); } }
      if (r.ok) { healthy++; console.log(`${a.uid.slice(0, 8)} 健康 200`); continue; }
      const kind = r.error?.kind ?? classify(r.status, r.respBody ?? "");
      if (kind !== "auth_expired") {
        other++;
        console.log(`${a.uid.slice(0, 8)} 保留 status=${r.status} kind=${kind} :: ${(r.respBody ?? "").slice(0, 120).replace(/\s+/g, " ")}`);
        continue;
      }
      note = "401";
    } catch (e: any) {
      other++;
      console.log(`${a.uid.slice(0, 8)} 保留 THROW ${e?.name} :: ${String(e?.message).slice(0, 100)}`);
      continue;
    }
    // 401：验证 refresh 是否还能救
    try {
      const patch = await refreshToken(cfg, auth);
      if (patch.accessToken) {
        await p.account.update({
          where: { uid: a.uid },
          data: {
            accessToken: patch.accessToken,
            refreshToken: patch.refreshToken ?? a.refreshToken,
            expiresAt: BigInt(patch.expiresAt ?? Number(a.expiresAt)),
            domain: patch.domain ?? a.domain,
          },
        });
        healthy++;
        console.log(`${a.uid.slice(0, 8)} 401 但刷新成功 → 已更新凭证`);
        continue;
      }
      note = "refresh returned no token";
    } catch (e) {
      note = e instanceof UpstreamError ? `${e.status} ${e.message}` : String((e as any)?.message ?? e);
    }
    dead++;
    const reason = "upstream 401 (token rejected); refresh failed: " + note.slice(0, 90);
    console.log(`${a.uid.slice(0, 8)} 死号 → ${dry ? "[dry-run] " : ""}禁用（${note.slice(0, 80)}）`);
    if (!dry) await pool.disable(a.uid, reason);
  }
  console.log(`\n汇总: 健康=${healthy} 死号=${dead} 其他=${other} 已禁用跳过=${skipped}${dry ? " (dry-run)" : ""}`);
  await p.$disconnect();
})().catch((e) => { console.error("ERR", e?.message ?? e); process.exit(1); });
