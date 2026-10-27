import { PrismaClient } from "@prisma/client";
import { getConfig } from "../src/lib/config";
import { chatStream } from "../src/lib/upstream/client";

const p = new PrismaClient();
const list = process.argv.slice(2).length ? process.argv.slice(2) : ["kimi-k3-1"];

(async () => {
  const cfg = await getConfig();
  const accts = await p.account.findMany({
    where: { realm: "cn", accessToken: { not: "" } },
    take: 3,
    orderBy: { updatedAt: "desc" },
  });
  console.log("accounts:", accts.map(a => a.uid.slice(0,6) + "…").join(", "));
  for (const a of accts.slice(0, 2)) {
    for (const m of list) {
      const body = JSON.stringify({ model: m, stream: false, messages: [{ role: "user", content: "hi" }] });
      try {
        const r = await chatStream(cfg, {
          uid: a.uid, nickname: a.nickname, realm: a.realm, accessToken: a.accessToken,
          refreshToken: a.refreshToken, expiresAt: Number(a.expiresAt), domain: a.domain,
          enterpriseId: a.enterpriseId, deviceToken: a.deviceToken,
        } as any, body, "", { conversationID: "probe-" + Date.now(), conversationRequestID: "", traceID: "" });
        const kind = r.error?.kind ?? "(none)";
        let txt = r.respBody ?? "";
        if (r.body) {
          const rd = r.body.getReader();
          let acc = "";
          while (true) { const { done, value } = await rd.read(); if (done) break; acc += new TextDecoder().decode(value); if (acc.length > 400) { await rd.cancel(); break; } }
          txt = "[stream] " + acc.slice(0, 300);
        }
        console.log(`--- uid=${a.uid.slice(0,6)}… model=${m} status=${r.status} kind=${kind}`);
        console.log(txt.slice(0, 400).replace(/\n/g, "\\n"));
      } catch (e: any) {
        console.log(`--- uid=${a.uid.slice(0,6)}… model=${m} THROW ${e?.name}: ${e?.message}`);
      }
    }
  }
  await p.$disconnect();
})().catch((e) => { console.error("ERR", e?.message ?? e); process.exit(1); });
