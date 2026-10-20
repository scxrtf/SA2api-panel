// backoff.ts 轮转退避与抖动的单一事实来源（移植 internal/server/backoff.go）：
// 指数基数/封顶/抖动比例一处定义，chat 轮转换号退避共用同一 jitter，不散落各处。

// ROTATE_BACKOFF_BASE_MS 轮转退避基数（对齐官方 intl CLI computeRequestRetryDelayMs
// 的 500ms 形态）。置 0 跳过等待（测试用）。
export const ROTATE_BACKOFF_BASE_MS = 500;
// ROTATE_BACKOFF_CAP_MS 轮转退避封顶（报告 P0-2 建议 8s：轮转上限默认 3 次，
// 实际等待序列 500ms/1s，封顶只约束极端配置下的 max_rotate）。
export const ROTATE_BACKOFF_CAP_MS = 8_000;
// JITTER_FRACTION 抖动比例（±25%，对齐 intl CLI delay×(1±0.25) 形态）。
export const JITTER_FRACTION = 0.25;

// jitterDur 给时长施加 ±jitterFraction 的均匀抖动，返回 [d·(1-f), d·(1+f)] 区间值。
// d<=0 原样返回（零等待不抖动）。抖动目的是打散多请求同相位重试（WAF 频控按
// 密度判罚，齐步走的退避会以固定周期再次聚团）。
export function jitterDur(d: number): number {
  if (d <= 0) return d;
  const f = 1 + (Math.random() * 2 - 1) * JITTER_FRACTION;
  return Math.max(0, Math.round(d * f));
}

// backoffAfter 返回第 n 次轮转（0 基：首次失败换号前 n=0）前应等待的退避时长：
// base·2^n 封顶 CAP，再施加 ±25% 抖动。base<=0（测试）时恒 0。
export function backoffAfter(n: number, base: number = ROTATE_BACKOFF_BASE_MS): number {
  let d = base;
  if (d <= 0) return 0;
  for (let k = 0; k < n && d < ROTATE_BACKOFF_CAP_MS; k++) {
    d *= 2;
  }
  if (d > ROTATE_BACKOFF_CAP_MS) d = ROTATE_BACKOFF_CAP_MS;
  return jitterDur(d);
}

// sleep 毫秒级等待（客户端断连检测由调用方在循环外判定，Node 无请求 ctx 取消等价物）。
export function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
