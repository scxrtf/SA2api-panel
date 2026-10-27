// _e2e-4xx: 验证请求级 4xx 不再轮转 8 次后误报 503 —— 用非法 role 触发上游 400。
import { handleChat } from "../src/lib/chat";

(async () => {
  const t0 = Date.now();
  const res = await handleChat({
    body: {
      model: "cn:kimi-k3-1",
      stream: true,
      messages: [],
    },
    clientIP: "127.0.0.1",
    inboundHeaders: new Headers(),
    ua: "e2e-4xx/local",
    path: "/v1/chat/completions",
  });
  const body = (await res.text()).slice(0, 400);
  console.log(`status=${res.status} 耗时=${Date.now() - t0}ms`);
  console.log("body:", body);
})().catch((e) => { console.error("ERR", e?.message ?? e); process.exit(1); });
