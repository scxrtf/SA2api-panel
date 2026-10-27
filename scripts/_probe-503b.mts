// _probe-503b: 挑处于软冷却 / 有 strikes 的账号直连上游，打印真实 HTTP 状态码 + 原始 body，
// 用于确认 classify 误判形态（14003 / 6000 / 401 APISIX HTML）。
import { PrismaClient } from "@prisma/client";
import { getConfig } from "../src/lib/config";
import { chatStream } from "../src/lib/upstream/client";

const p = new PrismaClient();
const model = process.argv[2] ?? "kimi-k3-1";
const want = Number(process.argv[3] ?? 3);

(async () => {
  const cfg = await getConfig();
  const all = await p.account.findMany({
    where: { realm: "cn", accessToken: { not: "" } },
    orderBy: { updatedAt: "desc" },
  });
  const cooling = all.filter((a) => String((a.state as any)?.cooldownReason ?? "").length > 0);
  const strikes = all.filter((a) => Number((a.state as any)?.sessionStrikes ?? 0) > 0);
  const pick = [...new Set([...cooling, ...strikes, ...all])].slice(0, want);
  console.log("total cn:", all.length, "cooling:", cooling.length, "strikes:", strikes.length);
  for (const a of pick) {
    const body = JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "hi" }] });
    const st = (a.state ?? {}) as any;
    try {
      const r = await chatStream(cfg, {
        uid: a.uid, nickname: a.nickname, realm: a.realm, accessToken: a.accessToken,
        refreshToken: a.refreshToken, expiresAt: Number(a.expiresAt), domain: a.domain,
        enterpriseId: a.enterpriseId, deviceToken: a.deviceToken,
      } as any, body, "", { conversationID: "probe-" + Date.now(), conversationRequestID: "", traceID: "" });
      let txt = r.respBody ?? "";
      if (r.body) {
        const rd = r.body.getReader();
        let acc = "";
        while (true) { const { done, value } = await rd.read(); if (done) break; acc += new TextDecoder().decode(value); if (acc.length > 600) { await rd.cancel(); break; } }
        txt = "[stream] " + acc.slice(0, 400);
      }
      console.log(`\n--- uid=${a.uid.slice(0, 8)}… status=${r.status} kind=${r.error?.kind ?? "(none)"} cool=${JSON.stringify(st.cooldownReason ?? "").slice(0, 90)}`);
      console.log("body:", txt.slice(0, 500).replace(/\s+/g, " "));
    } catch (e: any) {
      console.log(`\n--- uid=${a.uid.slice(0, 8)}… THROW ${e?.name}: ${e?.message}`);
    }
  }
  await p.$disconnect();
})().catch((e) => { console.error("ERR", e?.message ?? e); process.exit(1); });
