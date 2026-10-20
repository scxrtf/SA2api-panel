// wafip.ts WAF IP 级拦截 fail-fast 状态机（移植 internal/server/wafip.go）。
//
// 背景：WAF 403 拦的是网关出口 IP 而非账号——多账号 1 秒内全 403。
// 账号级软冷却在 IP 级拦截时不够：轮转会把一次客户端请求放大 max_rotate 倍，
// 同一出口 IP 继续打上游只会加重风控。
//
// 判定：60s 滑动窗内 ≥2 个不同 UID 接连命中 WAF 403 → 判定 IP 级拦截，激活
// 同样 60s（到期自然解除，激活期内新命中不续期）。单号反复 403 永不触发。
// 进程内状态、重启清零（窗口 60s，重建成本极低）。
// 挂 globalThis 保证 Next dev 热更新不重置（对齐 scheduler.ts 的单例约定）。

const WAF_IP_WINDOW_MS = 60_000;
const WAF_IP_THRESHOLD = 2;

interface WafIPState {
  hits: Map<string, number>; // uid → 最近一次 WAF 403 时刻（判定窗内，惰性剪枝）
  until: number;             // IP 级拦截激活截止（0 = 未激活）
}

const g = globalThis as unknown as { __wbWafIP?: WafIPState };
const st: WafIPState = g.__wbWafIP ?? (g.__wbWafIP = { hits: new Map(), until: 0 });

// noteWaf 记一次某账号的 WAF 403，返回记账后 IP 级拦截是否激活（调用方据此
// fail-fast 终止轮转，优先于轮转退避）。语义对齐 Go wafIPGate.noteWaf。
export function noteWaf(uid: string): boolean {
  const now = Date.now();
  if (now < st.until) return true; // 激活期内新命中：不续期、不记账
  st.hits.set(uid, now);
  for (const [u, t] of st.hits) {
    if (now - t > WAF_IP_WINDOW_MS) st.hits.delete(u);
  }
  if (st.hits.size >= WAF_IP_THRESHOLD) {
    st.until = now + WAF_IP_WINDOW_MS;
    console.warn(
      "[server] waf ip-level block: " + st.hits.size + " accounts hit waf 403 within " +
      (WAF_IP_WINDOW_MS / 1000) + "s, rotate fail-fast until " + new Date(st.until).toISOString(),
    );
    st.hits.clear(); // 解除后需全新命中重新判定，不叠旧账
    return true;
  }
  return false;
}

// active 报告 IP 级拦截是否激活（末端错误文案区分 IP 级/账号级措辞用）。
export function active(): boolean {
  return Date.now() < st.until;
}
