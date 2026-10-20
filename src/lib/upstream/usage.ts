// usage.ts usage 观测口径的单一事实来源（移植 Go internal/upstream/usage.go +
// sse.go 的 ensureUsageTotal + handler.go 的 tokensPerSecond）。
// 回写客户端、流式旁路统计、usage 台账三处共用，防止各处口径漂移。

type Obj = Record<string, unknown>;

// positiveUsageNumber 取严格正的数值；非数字 / 0 / 负数返回 false。
function positiveUsageNumber(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return v;
}

// usageNumber 顶层数值字段：存在且是有限数字即真（0 也算——区别于上者的
// 「正数」语义：miss=0 是合法观测）。
function usageNumber(u: Obj, key: string): number | null {
  const v = u[key];
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

// bestUsageCacheHitTokens 多别名取最优正值（顺序与 Go 一致）。
export function bestUsageCacheHitTokens(u: Obj): number | null {
  const paths: [string, string][] = [
    ["prompt_tokens_details", "cached_tokens"],
    ["", "prompt_cache_hit_tokens"],
    ["", "cache_read_input_tokens"],
    ["", "cached_tokens"],
    ["input_tokens_details", "cached_tokens"],
  ];
  for (const [section, key] of paths) {
    let v: unknown;
    if (section === "") {
      v = u[key];
    } else {
      const details = u[section];
      if (details && typeof details === "object" && !Array.isArray(details)) {
        v = (details as Obj)[key];
      }
    }
    const n = positiveUsageNumber(v);
    if (n !== null) return n;
  }
  return null;
}

// normalizeUsageCacheAliases 把最优命中值写回全部别名字段。部分 WorkBuddy 响应
// 把真实命中放 prompt_tokens_details.cached_tokens，同时又发 cache_read_input_tokens:0
// 兼容别名——严格客户端读零别名会丢命中。未命中（best<=0）时原样返回。
export function normalizeUsageCacheAliases(usage: Obj): Obj {
  const best = bestUsageCacheHitTokens(usage);
  if (best === null) return usage;
  const out: Obj = { ...usage };
  out["cache_read_input_tokens"] = best;
  out["cached_tokens"] = best;
  out["prompt_cache_hit_tokens"] = best;
  const pd = out["prompt_tokens_details"];
  out["prompt_tokens_details"] = {
    ...(pd && typeof pd === "object" && !Array.isArray(pd) ? (pd as Obj) : {}),
    cached_tokens: best,
  };
  // Responses API 消费者用嵌套形态：上游给了才保留，不为 Chat-only 客户端发明。
  if ("input_tokens_details" in out) {
    const id = out["input_tokens_details"];
    out["input_tokens_details"] = {
      ...(id && typeof id === "object" && !Array.isArray(id) ? (id as Obj) : {}),
      cached_tokens: best,
    };
  }
  return out;
}

// ensureUsageTotal usage 缺 total_tokens 但 prompt/completion 都在时补齐
// total = prompt + completion（新对象合并，不改原 map）。任一缺失或已有
// total 时原样返回。
export function ensureUsageTotal(u: Obj): Obj {
  if ("total_tokens" in u) return u;
  const pt = usageNumber(u, "prompt_tokens");
  const ct = usageNumber(u, "completion_tokens");
  if (pt === null || ct === null) return u;
  return { ...u, total_tokens: pt + ct };
}

// normalizeUsage 供客户端出口的统一组合：补 total → 归一缓存别名。
export function normalizeUsage(u: Obj): Obj {
  return normalizeUsageCacheAliases(ensureUsageTotal(u));
}

// usageCacheHitTokens 网关统计侧读取命中（与回写客户端口径一致）。
export function usageCacheHitTokens(u: Obj): number | null {
  return bestUsageCacheHitTokens(u);
}

// usageCacheMissTokens 优先显式 prompt_cache_miss_tokens；缺失时按
// prompt - hit 推导（推导值为负视为不可信）。
export function usageCacheMissTokens(u: Obj): number | null {
  const miss = usageNumber(u, "prompt_cache_miss_tokens");
  if (miss !== null) return miss;
  const prompt = usageNumber(u, "prompt_tokens");
  const hit = usageCacheHitTokens(u);
  if (prompt !== null && hit !== null && prompt - hit >= 0) return prompt - hit;
  return null;
}

// minGenWindow 可信生成窗口下限：扣 TTFB 后不足该值即视为「生成时长不可测」，
// 退回端到端耗时（Go handler.go:1437 同值同语义）。
const MIN_GEN_WINDOW_MS = 200;

// tokensPerSecond 吐字速率：分母用「生成耗时」= 端到端 - TTFB。TTFB<=0（无观测）
// 不猜不扣；生成窗不足 200ms 退回端到端，避免零/负分母或上万 tok/s 幻数。
export function tokensPerSecond(
  completionTokens: number,
  totalMs: number,
  ttfbMs: number,
): number | null {
  if (completionTokens < 0 || totalMs <= 0) return null;
  let gen = totalMs;
  if (ttfbMs > 0) {
    const g = totalMs - ttfbMs;
    if (g >= MIN_GEN_WINDOW_MS) gen = g;
  }
  return completionTokens / (gen / 1000);
}

// usageTokensFromResponse 从聚合响应提取 prompt/completion/total token
//（供应商记账用；缺失维度为 0，total 缺失时按 pt+ct 兜底）。
export function usageTokensFromResponse(
  resp: Obj,
): { pt: number; ct: number; tt: number } {
  const u = resp["usage"];
  if (!u || typeof u !== "object") return { pt: 0, ct: 0, tt: 0 };
  const m = u as Obj;
  const pt = usageNumber(m, "prompt_tokens") ?? 0;
  const ct = usageNumber(m, "completion_tokens") ?? 0;
  let tt = usageNumber(m, "total_tokens") ?? 0;
  if (tt === 0) tt = pt + ct;
  return { pt, ct, tt };
}
