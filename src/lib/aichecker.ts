// hlwy-ai-checker 模型指纹鉴别核心（Next.js 服务端移植）。
// 原理与判据 1:1 对齐上游 v2.6.1（hlwy-ai-checker.html）：
// 让模型反复「从 1 到 355 随机选一个数字」，统计 355 桶输出分布 + 众数，
// 与官方基准做 余弦相似度×e^(-JS散度) 与 众数得分 各占 50% 的综合匹配度。
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { authShapeOf } from "@/lib/login";
import { chatStream } from "@/lib/upstream/client";
import { providerEndpoint } from "@/lib/provider-endpoint";

export const DIST_LENGTH = 355;
export const BASE_PROMPT =
  "请从1到355之间随机选择一个数字，只输出这个数字，不要有任何其他内容。";
export const MIN_SAMPLES = 40;            // 出报告最少有效样本（对齐上游）
export const DEFAULT_ITERATIONS = 100;    // 上游默认采样次数
export const REPLACE_MARGIN_PCT = 0.5;    // 其他基准高出 0.5 个百分点即判可能替换
const SAMPLE_TIMEOUT_MS = 120_000;        // 单次采样（含一次扩预算重试）上限

// 规范化官方基准（对齐上游 normalizeBaseline；内置快照是同一生成器产物）。
export function normalizeBaseline(raw: unknown): Baseline | null {
  // 内置快照顶层是单元素数组（上游导出格式），剥一层再校验。
  if (Array.isArray(raw)) {
    return raw.length === 1 ? normalizeBaseline(raw[0]) : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const dist = r.distribution;
  if (!Array.isArray(dist) || dist.length !== DIST_LENGTH) return null;
  const distribution: number[] = [];
  for (const v of dist) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
    distribution.push(v);
  }
  const s = r.stats as Record<string, unknown> | undefined;
  if (!s || typeof s !== "object") return null;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const mean = num(s.mean), stdDev = num(s.stdDev), median = num(s.median);
  if (mean === undefined || stdDev === undefined || median === undefined) return null;
  const stats: BaselineStats = { mean, stdDev, median };
  for (const k of ["min", "max", "unique", "mode", "modeCount"] as const) {
    const v = num(s[k]);
    if (v !== undefined) stats[k] = v;
  }
  const name = typeof r.name === "string" ? r.name : "";
  if (!name) return null;
  return {
    name,
    model: typeof r.model === "string" ? r.model : "",
    apiType: typeof r.apiType === "string" ? r.apiType : "openai",
    timestamp: typeof r.timestamp === "string" ? r.timestamp : new Date().toISOString(),
    iterations: num(r.iterations) ?? 0,
    distribution,
    stats,
  };
}

// 官方基准快照（public/aichecker/baselines）经 /api/panel/aichecker/baseline(s) 提供，
// 数据结构对齐上游 normalizeBaseline 输出。
export interface BaselineStats {
  mean: number; stdDev: number; median: number;
  min?: number; max?: number; unique?: number;
  mode?: number; modeCount?: number;
}
export interface Baseline {
  name: string; model: string; apiType: string;
  timestamp: string; iterations: number;
  distribution: number[]; stats: BaselineStats;
}

// 反针对模式（对齐上游 buildPrompt）：每次请求在随机位置插入 1 个空格，
// 避免中转站按固定提示词识别探测流量；不插在首尾与两个数字之间。
export function buildPrompt(antiTarget: boolean, rand: () => number = Math.random): string {
  if (!antiTarget) return BASE_PROMPT;
  const gaps: number[] = [];
  for (let i = 1; i < BASE_PROMPT.length; i++) {
    if (!(/\d/.test(BASE_PROMPT[i - 1]) && /\d/.test(BASE_PROMPT[i]))) gaps.push(i);
  }
  const pos = gaps[Math.floor(rand() * gaps.length)];
  return BASE_PROMPT.slice(0, pos) + " " + BASE_PROMPT.slice(pos);
}

// extractNumber 对齐上游：取第一段连续数字，须在 1-355 内。
export function extractNumber(text: string): number | null {
  const m = /\d+/.exec(text);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return n >= 1 && n <= DIST_LENGTH ? n : null;
}

// calculateDistribution 对齐上游：355 桶频率分布。
export function calculateDistribution(numbers: number[]): number[] {
  const counts = new Array(DIST_LENGTH).fill(0);
  for (const n of numbers) if (n >= 1 && n <= DIST_LENGTH) counts[n - 1]++;
  const total = numbers.length;
  return counts.map((c) => c / total);
}

// calculateStats 对齐上游：均值/中位/标准差/极值/唯一值数/众数。
export function calculateStats(numbers: number[]): Required<BaselineStats> {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
  const variance = numbers.reduce((s, x) => s + (x - mean) ** 2, 0) / numbers.length;
  const freq = new Map<number, number>();
  for (const n of numbers) freq.set(n, (freq.get(n) ?? 0) + 1);
  let modeVal = numbers[0], modeCount = 0;
  for (const [k, v] of freq) if (v > modeCount) { modeCount = v; modeVal = k; }
  return {
    mean, median: sorted[Math.floor(sorted.length / 2)],
    stdDev: Math.sqrt(variance), min: sorted[0],
    max: sorted[sorted.length - 1], unique: new Set(numbers).size,
    mode: modeVal, modeCount,
  };
}

export interface Similarity {
  cosineSimilarity: number; jsDivergence: number; modeScore: number; overallScore: number;
}

// calculateSimilarity 对齐上游：余弦×e^(-JS) 与 众数得分（差 50 内线性衰减）各半。
export function calculateSimilarity(
  dist1: number[], dist2: number[],
  stats1?: BaselineStats | null, stats2?: BaselineStats | null,
): Similarity {
  if (dist1.length !== DIST_LENGTH || dist2.length !== DIST_LENGTH) {
    return { cosineSimilarity: 0, jsDivergence: Infinity, modeScore: 0, overallScore: 0 };
  }
  const sum1 = dist1.reduce((s, v) => s + v, 0);
  const sum2 = dist2.reduce((s, v) => s + v, 0);
  if (sum1 <= 0 || sum2 <= 0) {
    return { cosineSimilarity: 0, jsDivergence: Infinity, modeScore: 0, overallScore: 0 };
  }
  let dot = 0, norm1 = 0, norm2 = 0, jsDiv = 0;
  const eps = 1e-12;
  for (let i = 0; i < DIST_LENGTH; i++) {
    const p = dist1[i] / sum1;
    const q = dist2[i] / sum2;
    dot += p * q; norm1 += p * p; norm2 += q * q;
    const m = (p + q) / 2;
    if (p > 0) jsDiv += 0.5 * p * Math.log((p + eps) / (m + eps));
    if (q > 0) jsDiv += 0.5 * q * Math.log((q + eps) / (m + eps));
  }
  const cosineSim = dot / (Math.sqrt(norm1) * Math.sqrt(norm2));
  const distribScore = cosineSim * Math.exp(-jsDiv);
  let modeScore = 0;
  if (stats1 && stats2) {
    const m1 = stats1.mode, m2 = stats2.mode;
    if (m1 !== undefined && m2 !== undefined) {
      modeScore = m1 === m2 ? 1 : Math.max(0, 1 - Math.abs(m1 - m2) / 50);
    }
  }
  return { cosineSimilarity: cosineSim, jsDivergence: jsDiv, modeScore, overallScore: modeScore * 0.5 + distribScore * 0.5 };
}

export const scoreToPct = (score: number) => Number((score * 100).toFixed(2));
export const scoreGapPct = (a: number, b: number) =>
  Math.round((scoreToPct(a) - scoreToPct(b)) * 100) / 100;

// getPurityVerdict 对齐上游：≥96 一致 / ≥92 少许降智 / 其余严重降智或偷换。
export function purityVerdict(score: number): { text: string; level: "good" | "warn" | "bad" } {
  const pct = scoreToPct(score);
  if (pct >= 96) return { text: "模型一致", level: "good" };
  if (pct >= 92) return { text: "模型有少许降智", level: "warn" };
  return { text: "模型严重降智或者被偷换为其他模型", level: "bad" };
}

// quickVerdict 对齐上游 getQuickVerdict：其他官方基准高出阈值优先判「可能被替换」。
export function quickVerdict(claimed: number, bestOther: number | null):
  { text: string; level: "good" | "warn" | "bad"; replaced: boolean } {
  if (bestOther !== null && scoreGapPct(bestOther, claimed) >= REPLACE_MARGIN_PCT) {
    return { text: "模型可能被替换", level: "bad", replaced: true };
  }
  return { ...purityVerdict(claimed), replaced: false };
}

// ---- 探测通道 ----

export type SampleChannel =
  | { kind: "pool"; realm: "cn" | "global"; bare: string; uid?: string }
  | { kind: "provider"; providerName: string; bare: string }
  | { kind: "external"; baseUrl: string; apiKey: string; bare: string };

// 解析面板模型 id（与 models/test、models/probe 同一前缀语义）：
// cn:/global: 池域、其他前缀为供应商名、无前缀默认 cn；亦接受显式外站配置。
export function resolveChannel(input: {
  model: string; base_url?: string; api_key?: string; uid?: string;
}): SampleChannel {
  const model = input.model.trim();
  if (input.base_url && input.api_key) {
    return { kind: "external", baseUrl: input.base_url.trim().replace(/\/+$/, ""), apiKey: input.api_key.trim(), bare: model };
  }
  const ci = model.indexOf(":");
  if (ci > 0) {
    const prefix = model.slice(0, ci);
    const bare = model.slice(ci + 1);
    if (prefix === "cn" || prefix === "global") return { kind: "pool", realm: prefix, bare, uid: input.uid };
    return { kind: "provider", providerName: prefix, bare };
  }
  return { kind: "pool", realm: "cn", bare: model, uid: input.uid };
}

// sampleOnce 发一次随机数请求，返回提取到的数字（无法解析为 1-355 返回 null）。
// 池通道走 chatStream（与 models/test 一致）；供应商/外站直连 OpenAI 兼容端点。
export async function sampleOnce(
  ch: SampleChannel, prompt: string, signal: AbortSignal, tag: string,
): Promise<number | null> {
  // 单次采样超时与调用方取消信号合并：避免个别请求卡死整轮鉴别。
  const timeout = AbortSignal.timeout(SAMPLE_TIMEOUT_MS);
  const sig = AbortSignal.any([signal, timeout]);
  try {
    if (ch.kind === "pool") {
      const where = ch.uid
        ? { uid: ch.uid }
        : { realm: ch.realm, accessToken: { not: "" }, state: { is: { disabled: false, paused: false } } };
      const acct = await prisma.account.findFirst({ where, include: { state: true } });
      if (!acct || acct.accessToken === "") throw new Error("no available account for realm " + ch.realm);
      const cfg = await getConfig();
      const meta = { conversationID: "aicheck-" + tag, conversationRequestID: "aicheck:" + tag, traceID: "aicheck:" + tag };
      // 不传 thinking / reasoning_effort：与上游 hlwy-ai-checker 的请求体一致，
      // 让模型走自己的默认思考档。实测主动关思考会改变数字分布（deepseek 关闭
      // 后众数从 217 漂到 187/247），直接影响与官方基准的可比性。
      // max_tokens 给足思考余量；上限不计费，只按实际生成量扣 token。
      const res = await chatStream(cfg, authShapeOf(acct), poolBody(ch.bare, prompt, 4096), "", meta, sig);
      if (res.status >= 400) throw new Error(`API错误: ${res.status} - ${(res.respBody ?? "").slice(0, 300)}`);
      if (!res.body) throw new Error("upstream returned no stream");
      const r = await readStreamText(res.body, sig);
      const n = extractNumber(r.content);
      if (n !== null) return n;
      if (r.content.trim()) return null;
      if (r.reasoningLen === 0) throw new Error("模型返回空正文");
      throw new Error(
        `模型只输出思考内容（${r.reasoningLen} 字符），未产出正文；该模型思考过长，不适合做指纹采样`,
      );
    }
    let base: string | undefined;
    let key: string | undefined;
    if (ch.kind === "provider") {
      const p = await prisma.provider.findUnique({ where: { name: ch.providerName } });
      base = p?.baseUrl; key = p?.apiKey;
    } else {
      base = ch.baseUrl; key = ch.apiKey;
    }
    if (!base || !key) throw new Error("provider not registered: " + (ch.kind === "provider" ? ch.providerName : ""));
    const endpoint = providerEndpoint(base, "/chat/completions");
    const body = remoteBody(ch.bare, prompt, "max_tokens");
    let resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body, signal: sig,
    });
    if (resp.status === 400) {
      // 新版 OpenAI 推理模型只认 max_completion_tokens。
      const raw = await resp.text();
      if (!/max_completion_tokens/i.test(raw)) throw new Error(`API错误: 400 - ${raw.slice(0, 300)}`);
      resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: remoteBody(ch.bare, prompt, "max_completion_tokens"), signal: sig,
      });
    }
    if (!resp.ok) throw new Error(`API错误: ${resp.status} - ${(await resp.text()).slice(0, 300)}`);
    const data = await resp.json() as {
      choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
    };
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      if (choice?.finish_reason === "length") {
        throw new Error("模型思考占满 max_tokens，未产出正文；请改用可关闭思考的模型");
      }
      throw new Error("没有返回可读字段");
    }
    return extractNumber(content.trim());
  } catch (e) {
    if (timeout.aborted && !signal.aborted) throw new Error(`单次采样超时（${SAMPLE_TIMEOUT_MS / 1000}s）`);
    throw e;
  }
}

// poolBody 池通道请求体：不注入 thinking/reasoning_effort（对齐上游请求形态）。
function poolBody(model: string, prompt: string, maxTokens: number): string {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 1.0,
    max_tokens: maxTokens,
  });
}

// remoteBody 供应商/外站请求体；field 用于 max_tokens / max_completion_tokens 自适应。
function remoteBody(model: string, prompt: string, field: "max_tokens" | "max_completion_tokens"): string {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 1.0,
    [field]: 2048,
  });
}

// 池通道上游强制流式，读干流拼接正文；同时记录思考内容长度用于诊断。
async function readStreamText(
  stream: ReadableStream<Uint8Array>, signal: AbortSignal,
): Promise<{ content: string; reasoningLen: number }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "", out = "", reasoningLen = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new Error("check cancelled");
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const obj = JSON.parse(data) as {
            choices?: { delta?: { content?: string; reasoning_content?: string } }[];
          };
          const delta = obj.choices?.[0]?.delta;
          out += delta?.content ?? "";
          reasoningLen += (delta?.reasoning_content ?? "").length;
        } catch { /* 非 JSON 行跳过 */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { content: out, reasoningLen };
}
