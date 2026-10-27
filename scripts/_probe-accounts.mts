// _probe-accounts: 逐账号直连上游发最小请求，打印真实状态码 + 分类 + 原文片段
import { PrismaClient } from "@prisma/client";
import { getConfig } from "../src/lib/config";
import { chatStream } from "../src/lib/upstream/client";

const p = new PrismaClient();
const model = process.argv[2] ?? "kimi-k3-1";

(async () => {
  const cfg = await getConfig();
  const accts = await p.account.findMany({
    where: { realm: "cn", accessToken: { not: "" } },
    orderBy: { updatedAt: "desc" },
    include: { state: true },
  });
  console.log("accounts:", accts.length, "model:", model);
  const tally: Record<string, number> = {};
  for (const a of accts) {
    const auth = {
      uid: a.uid, nickname: a.nickname, realm: a.realm, accessToken: a.accessToken,
      refreshToken: a.refreshToken, expiresAt: Number(a.expiresAt), domain: a.domain,
      enterpriseId: a.enterpriseId, deviceToken: a.deviceToken,
    } as any;
    const body = JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hi" }] });
    const t0 = Date.now();
    try {
      const r = await chatStream(cfg, auth, body, "", { conversationID: "probe-" + Date.now(), conversationRequestID: "", traceID: "" });
      let txt = (r.respBody ?? "").slice(0, 240).replace(/\s+/g, " ");
      if (r.body) { const rd = r.body.getReader(); try { await rd.read(); txt = "[stream ok]"; } finally { await rd.cancel(); } }
      const key = r.status + "|" + (r.error?.kind ?? "-");
      tally[key] = (tally[key] || 0) + 1;
      console.log(`${a.uid.slice(0, 8)} ${String(Date.now() - t0).padStart(5)}ms status=${r.status} kind=${r.error?.kind ?? "-"} :: ${txt}`);
    } catch (e: any) {
      tally["THROW|" + e?.name] = (tally["THROW|" + e?.name] || 0) + 1;
      console.log(`${a.uid.slice(0, 8)} ${String(Date.now() - t0).padStart(5)}ms THROW ${e?.name}: ${String(e?.message).slice(0, 160)}`);
    }
  }
  console.log("\ntally", tally);
  await p.$disconnect();
})().catch((e) => { console.error("ERR", e?.message ?? e); process.exit(1); });
