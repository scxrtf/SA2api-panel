// _e2e-503: 端到端复现/验收 503|client —— 直接走 handleChat（不依赖 HTTP 层鉴权）。
// 用法：npx tsx scripts/_e2e-503.mts [model] [次数]
import { PrismaClient } from "@prisma/client";
import { handleChat } from "../src/lib/chat";

const p = new PrismaClient();
const model = process.argv[2] ?? "cn:kimi-k3-1";
const rounds = Number(process.argv[3] ?? 3);

async function poolStat(tag: string) {
  const accts = await p.account.findMany({ where: { realm: "cn" }, include: { state: true } });
  const dead = accts.filter((a) => a.state?.disabled);
  console.log(
    `[${tag}] cn 账号=${accts.length} 已禁用=${dead.length}` +
    (dead.length ? " → " + dead.map((a) => a.uid.slice(0, 8)).join(",") : ""),
  );
}

(async () => {
  await poolStat("before");
  for (let i = 1; i <= rounds; i++) {
    const t0 = Date.now();
    const res = await handleChat({
      body: {
        model,
        stream: true,
        messages: [{ role: "user", content: "只回复两个字：收到" }],
      },
      clientIP: "127.0.0.1",
      inboundHeaders: new Headers(),
      ua: "e2e-503/local",
      path: "/v1/chat/completions",
    });
    const ms = Date.now() - t0;
    let preview = "";
    if (res.headers.get("content-type")?.includes("event-stream") && res.body) {
      const rd = res.body.getReader();
      const { value } = await rd.read();
      preview = new TextDecoder().decode(value ?? new Uint8Array()).slice(0, 120).replace(/\s+/g, " ");
      await rd.cancel();
    } else {
      preview = (await res.text()).slice(0, 220).replace(/\s+/g, " ");
    }
    console.log(`round ${i}: status=${res.status} ${ms}ms :: ${preview}`);
  }
  await poolStat("after");
  await p.$disconnect();
})().catch((e) => { console.error("ERR", e?.message ?? e); process.exit(1); });
