// modelCatalog.ts /v1/models 元数据增强（移植 internal/upstream/model_catalog.go +
// context_catalog.go + global_models.go + client.go FetchModels 动态目录解析）。
//
// context_length / max_output_tokens 四级查找链：
//   1. 上游动态值（ModelInfo.contextWindow/maxTokens）——权威，永远优先；
//   2. 静态种子表（CONTEXT_CAP_FALLBACK，编译期兜底，CN/global 共用）；
//   3. model.json 本地缓存（数据目录，落盘持久化；损坏降级种子 + WARN 不崩溃）；
//   4. models.dev 按需拉取（异步不阻塞；负缓存 24h；context_length 兜底 1M
//      宁可高估不低估，max_output_tokens 未知 → 省略不编造）。
//
// global 域目录四路并发探测（global_models.go）：/v3/config 三种 UA
// （桌面端主路 + IDE + CLI）+ 企业端点家族（/v2 → /console），
// v3 条目字段权威、企业端点补缺 id。纯动态：拉不出即空名单，无静态回落。

import { CHAT_BASE_CN, GLOBAL_BASE, type AuthShape, commonHeaders } from "./client";
import type { AppConfig } from "../config";

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

// ---------- ModelInfo：上游模型目录全字段（对齐 Go ModelInfo） ----------

export interface ModelInfoFull {
  id: string;
  name?: string;
  contextWindow: number; // = maxInputTokens
  maxTokens: number; // = maxOutputTokens（思考与最终回答共享此预算）
  efforts?: string[]; // reasoning.supportedEfforts（空=未知/固定档）
  defaultEffort?: string; // reasoning.defaultEffort（新键）或 reasoning.effort（老键）
  description?: string; // descriptionZh 中文描述
  credits?: string; // 积分倍率原文（如 "x0.05"），仅展示不参与选号
  tags?: string[];
  vendor?: string;
  isDefault?: boolean;
  supportsReasoning?: boolean;
  supportsToolCall?: boolean;
  onlyReasoning?: boolean;
  supportsImages?: boolean;
  maxAllowedSize?: number;
  canDisableThinking?: boolean;
  reasoningEffort?: string; // reasoning.effort（与 supportedEfforts 不同源）
  reasoningSummary?: string; // reasoning.summary（如 "auto"）
  // 限时优惠（/v3/config data.modelPromotions）：credits 是牌价，promo* 是生效价。
  promoFactor?: number; // 折扣系数（0=限时免费，0.5=五折）
  promoCredits?: string; // 折扣后倍率原文（如 "0x" / "0.50x"）
  promoLabel?: string; // 徽章文案（限时免费 / 夜间折扣 / 错峰使用）
  promoNote?: string; // hover 说明原文
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// dynModelEntry 上游目录单条解析形态（CN /console 与 global /v2 同构）。
type DynEntry = {
  id?: string;
  name?: string;
  modelId?: string;
  model?: string;
  descriptionZh?: string;
  credits?: string;
  tags?: string[];
  vendor?: string;
  isDefault?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxAllowedSize?: number;
  disabled?: boolean;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  supportsToolCall?: boolean;
  onlyReasoning?: boolean;
  reasoning?: {
    effort?: string;
    summary?: string;
    defaultEffort?: string;
    canDisableThinking?: boolean;
    supportedEfforts?: string[];
  };
};

// dynToModelInfo dynEntry→ModelInfo 映射（单一事实来源；defaultEffort 新键优先、
// effort 老键兜底）。
function dynToModelInfo(m: DynEntry): ModelInfoFull {
  const def = m.reasoning?.defaultEffort || m.reasoning?.effort || "";
  return {
    id: m.id ?? "",
    name: m.name,
    contextWindow: m.maxInputTokens ?? 0,
    maxTokens: m.maxOutputTokens ?? 0,
    efforts: m.reasoning?.supportedEfforts,
    defaultEffort: def !== "" ? def : undefined,
    supportsImages: m.supportsImages,
    description: m.descriptionZh,
    credits: m.credits,
    tags: m.tags,
    vendor: m.vendor,
    isDefault: m.isDefault,
    supportsReasoning: m.supportsReasoning,
    supportsToolCall: m.supportsToolCall,
    onlyReasoning: m.onlyReasoning,
    maxAllowedSize: m.maxAllowedSize,
    canDisableThinking: m.reasoning?.canDisableThinking,
    reasoningEffort: m.reasoning?.effort,
    reasoningSummary: m.reasoning?.summary,
  };
}

// nonChatModel 判定非对话模型（从模型列表过滤）：
//   - id 前缀 nes-/completion-/codewise-（嵌入/补全/代码专用，选上报 11102）；
//   - maxOutputTokens ≤ 256（tiny 输出非对话）；
//   - tags 含生成类标签（text-to-image/image-to-image/text-to-video/image-to-video）。
// CN 与 global 共用同一口径。
function nonChatModel(id: string, maxOutputTokens: number, tags?: string[]): boolean {
  const low = id.trim().toLowerCase();
  for (const p of ["nes-", "completion-", "codewise-"]) {
    if (low.startsWith(p)) return true;
  }
  if (maxOutputTokens > 0 && maxOutputTokens <= 256) return true;
  for (const t of tags ?? []) {
    if (["text-to-image", "image-to-image", "text-to-video", "image-to-video"].includes(t)) return true;
  }
  return false;
}

// ---------- UA 常量（对齐 Go headers.go / client.go） ----------

// /v3/config 要求能解析出 CodeBuddy 版本号的 UA：CLI 三段式 UA 会拿到精简目录
// （无 supportedEfforts），官方 IDE 头才返回完整能力。
const CODEBUDDY_IDE_UA = "CodeBuddyIDE/4.12.0 CodeBuddy/4.12.0";
// CLI 三段式 UA：该端点对不同 UA 下发不同模型集合。
const CODEBUDDY_CLI_UA = "CLI/2.63.2 CodeBuddy/2.63.2";

// ---------- 静态种子表（context_catalog.go contextCapFallback，CN/global 共用） ----------

// DEFAULT_CONTEXT_WINDOW 知识表未收录的模型 context_length 兜底：1M（宁可高估不低估）。
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

interface ContextCap {
  context: number;
  maxOutput: number; // 0 = 未知 → 省略字段（不编造）
}

const CONTEXT_CAP_FALLBACK: Record<string, ContextCap> = {
  // GLM 家族（z-ai）
  "glm-5.2": { context: 1000000, maxOutput: 131072 },
  "glm-5.1": { context: 200000, maxOutput: 131072 },
  "glm-5.3": { context: 1000000, maxOutput: 131072 },
  "glm-5.3-flash": { context: 1000000, maxOutput: 131072 },
  "glm-5v-turbo": { context: 200000, maxOutput: 131072 },
  // Kimi 家族（moonshot）
  "kimi-k2.7": { context: 256000, maxOutput: 65536 },
  "kimi-k2.6": { context: 256000, maxOutput: 262144 },
  "kimi-k2.5": { context: 164000, maxOutput: 262144 },
  "kimi-k3": { context: 1048576, maxOutput: 131072 },
  "kimi-k2.8-preview": { context: 1048576, maxOutput: 0 },
  // MiniMax / 混元（tencent）
  "minimax-m3": { context: 512000, maxOutput: 512000 },
  "hy3": { context: 192000, maxOutput: 64000 },
  "hy3-preview": { context: 262144, maxOutput: 64000 },
  "hy4-preview": { context: 1000000, maxOutput: 64000 },
  "hy4-preview-x": { context: 1000000, maxOutput: 64000 },
  // DeepSeek 家族
  "deepseek-v4-pro": { context: 1000000, maxOutput: 384000 },
  "deepseek-v4-flash": { context: 1000000, maxOutput: 384000 },
  "deepseek-v4.1-flash": { context: 1000000, maxOutput: 384000 },
  // OpenAI / Google（global 域家族）
  "gpt-6-astra": { context: 1050000, maxOutput: 128000 },
  "gpt-5.6-sol": { context: 1050000, maxOutput: 128000 },
  "gpt-5.6-terra": { context: 1050000, maxOutput: 128000 },
  "gpt-5.6-luna": { context: 1050000, maxOutput: 128000 },
  "gpt-5.5": { context: 1050000, maxOutput: 128000 },
  "gpt-5.4": { context: 1050000, maxOutput: 128000 },
  "gpt-5.3-codex": { context: 400000, maxOutput: 128000 },
  "gemini-3.5-flash": { context: 1048576, maxOutput: 65536 },
  // global 域路由别名
  "auto": { context: 168000, maxOutput: 0 },
};

// ---------- 第 3 级：model.json 落盘缓存（移植 model_catalog.go） ----------
//
// 数据目录 model.json 原子落盘（tmp+rename，与 Go saveLocked 同模式）；启动惰性加载，
// 损坏整体降级种子 + WARN 不崩溃，条目级非法剔除；source 字段区分 seed/modelsdev/manual。
// 单进程内所有读写同步（Node 单线程 + sync fs 调用，无并发竞争，等价 Go 的全程持锁）。

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

interface ModelCapEntry {
  contextLength: number;
  maxOutputTokens: number; // 0 = 未知 → 省略字段
  fetchedAt?: string; // RFC3339；seed 条目为空
  source: string; // seed / modelsdev / manual（手动维护条目保留原 source 字符串）
}

// model.json 落盘路径：WB2API_DATA_DIR 环境变量指定数据目录（与 Go 数据目录同风格），
// 默认 <cwd>/data/model.json；置空字符串（WB2API_DATA_DIR="" 不作禁用语义——用
// WB2API_MODEL_JSON_DISABLE=1 显式禁用持久化，退化为纯内存 + 种子，测试用）。
const catalogPath = process.env.WB2API_MODEL_JSON_DISABLE === "1"
  ? ""
  : join(process.env.WB2API_DATA_DIR || join(process.cwd(), "data"), "model.json");

const catalogEntries = new Map<string, ModelCapEntry>();
let catalogLoaded = false;

function validCapEntry(e: ModelCapEntry): boolean {
  return e.contextLength > 0 && e.maxOutputTokens >= 0;
}

// loadSeedLocked 等价物：静态种子表灌入 entries（Go 为 embed model.json，
// 本版种子直接来自 CONTEXT_CAP_FALLBACK——同一批值，少一次文件中转）。
function loadCatalogSeed(): void {
  for (const [id, cap] of Object.entries(CONTEXT_CAP_FALLBACK)) {
    catalogEntries.set(id, {
      contextLength: cap.context, maxOutputTokens: cap.maxOutput, source: "seed",
    });
  }
}

// initLocked 等价物：惰性首次加载。文件不存在/不可读 → 种子；整体损坏 → 种子 + WARN；
// 条目非法 → 剔除 + WARN。
function ensureCatalogLoaded(): void {
  if (catalogLoaded) return;
  catalogLoaded = true;
  if (catalogPath === "") {
    loadCatalogSeed();
    return;
  }
  let raw: string;
  try {
    raw = readFileSync(catalogPath, "utf8");
  } catch {
    loadCatalogSeed();
    return;
  }
  let file: Record<string, unknown>;
  try {
    file = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    console.warn(
      "WARN: [upstream] model.json 损坏（降级内置种子表）: path=" + catalogPath +
      " err=" + (e instanceof Error ? e.message : String(e)),
    );
    loadCatalogSeed();
    return;
  }
  for (const [id, v] of Object.entries(file)) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const entry: ModelCapEntry = {
      contextLength: typeof o["context_length"] === "number" ? o["context_length"] : 0,
      maxOutputTokens: typeof o["max_output_tokens"] === "number" ? o["max_output_tokens"] : 0,
      fetchedAt: typeof o["fetched_at"] === "string" ? o["fetched_at"] : undefined,
      source: typeof o["source"] === "string" && o["source"] !== "" ? (o["source"] as string) : "manual",
    };
    if (!validCapEntry(entry)) {
      console.warn("WARN: [upstream] model.json 条目非法剔除: model=" + id);
      continue;
    }
    catalogEntries.set(id, entry);
  }
}

// saveLocked 等价物：原子落盘（tmp + rename）。不可写静默（内存缓存仍生效）。
function saveCatalog(): void {
  if (catalogPath === "") return;
  const out: Record<string, unknown> = {};
  for (const [id, e] of [...catalogEntries.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const o: Record<string, unknown> = {
      context_length: e.contextLength,
      source: e.source,
    };
    if (e.maxOutputTokens > 0) o["max_output_tokens"] = e.maxOutputTokens;
    if (e.fetchedAt) o["fetched_at"] = e.fetchedAt;
    out[id] = o;
  }
  try {
    mkdirSync(dirname(catalogPath), { recursive: true });
    const tmp = catalogPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    renameSync(tmp, catalogPath);
  } catch (e) {
    console.warn(
      "WARN: [upstream] model.json 落盘失败（内存缓存仍生效）: path=" + catalogPath +
      " err=" + (e instanceof Error ? e.message : String(e)),
    );
  }
}

function modelCatalogGet(model: string): ModelCapEntry | undefined {
  ensureCatalogLoaded();
  const e = catalogEntries.get(model);
  if (!e || !validCapEntry(e)) return undefined;
  return e;
}

// put：运行时拉取值采信 models.dev 官方源优先口径，覆盖已有条目（含手编——
// 若不希望覆盖，删掉 model.json 里对应条目即可）。
function modelCatalogPut(model: string, context: number, maxOutput: number): void {
  if (!model || context <= 0 || maxOutput < 0) return;
  ensureCatalogLoaded();
  catalogEntries.set(model, {
    contextLength: context,
    maxOutputTokens: maxOutput,
    fetchedAt: new Date().toISOString(),
    source: "modelsdev",
  });
  saveCatalog();
}

// ---------- 第 4 级：models.dev 按需拉取（异步不阻塞；负缓存 24h） ----------

const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_TIMEOUT_MS = 5000;
const MODELS_DEV_FETCH_COOLDOWN_MS = 5 * 60_000; // 5min 整体节流
const MODELS_DEV_NEGATIVE_TTL_MS = 24 * 3600_000; // 同模型 24h 负缓存
const MODELS_DEV_VALUE_MAX = 1e9;

// 官方 vendor provider 优先名单（其余取众数共识）。
const MODELS_DEV_VENDOR_SOURCES = new Set([
  "zai", "moonshotai", "moonshotai-cn", "openai", "google", "deepseek", "minimax",
]);

interface ModelsDevEntry {
  context: number;
  output: number;
}

// fetcher 状态（Go modelsDevFetcher 同构：doc 索引 + 节流 + 负缓存 + 在途去重）。
let mdDoc: Map<string, ModelsDevEntry> | null = null;
let mdLastFetch = 0;
let mdFetched = false;
const mdNegatives = new Map<string, number>();
let mdInflight: Promise<void> | null = null;

function mdNegativeFresh(model: string): boolean {
  const t = mdNegatives.get(model);
  return t !== undefined && Date.now() - t < MODELS_DEV_NEGATIVE_TTL_MS;
}

// lookup 查进程内文档索引；未命中记负缓存（不刷新既有条目的时刻——TTL 从首次
// miss 起算，防持续出现的未知模型把条目续期成永驻）。
function mdLookup(model: string): ModelsDevEntry | undefined {
  if (mdDoc) {
    const e = mdDoc.get(model);
    if (e) return e;
  }
  if (!mdNegatives.has(model)) mdNegatives.set(model, Date.now());
  return undefined;
}

// parseModelsDevDoc 解析 {provider:{models:{id:{limit:{context,output}}}}} → 裸 id 索引。
// 同名多 provider 采值优先级：官方 vendor 源 > 票数众数 > provider 字典序（确定性）。
export function parseModelsDevDoc(raw: string): Map<string, ModelsDevEntry> {
  const doc = JSON.parse(raw) as Record<
    string,
    { models?: Record<string, { limit?: { context?: number; output?: number } | null }> }
  >;
  interface Candidate {
    entry: ModelsDevEntry;
    vendor: boolean;
    votes: number;
    minProvider: string;
  }
  const byModel = new Map<string, Candidate[]>();
  for (const [provider, pv] of Object.entries(doc)) {
    for (const [fullID, mv] of Object.entries(pv?.models ?? {})) {
      const limit = mv?.limit;
      if (!limit) continue;
      const slash = fullID.lastIndexOf("/");
      const id = slash >= 0 ? fullID.slice(slash + 1) : fullID;
      if (!id) continue;
      const ctx = limit.context ?? 0;
      const out = limit.output ?? 0;
      if (ctx <= 0 || ctx > MODELS_DEV_VALUE_MAX) continue;
      if (out < 0 || out > MODELS_DEV_VALUE_MAX) continue;
      const key = `${ctx}/${out}`;
      const list = byModel.get(id) ?? [];
      const dup = list.find((c) => `${c.entry.context}/${c.entry.output}` === key);
      if (dup) {
        dup.votes++;
        if (MODELS_DEV_VENDOR_SOURCES.has(provider)) dup.vendor = true;
        if (provider < dup.minProvider) dup.minProvider = provider;
      } else {
        list.push({
          entry: { context: ctx, output: out },
          vendor: MODELS_DEV_VENDOR_SOURCES.has(provider),
          votes: 1,
          minProvider: provider,
        });
      }
      byModel.set(id, list);
    }
  }
  const out = new Map<string, ModelsDevEntry>();
  for (const [id, cs] of byModel) {
    let best = cs[0];
    for (const c of cs) {
      const better =
        (c.vendor && !best.vendor) ||
        (c.vendor === best.vendor && c.votes > best.votes) ||
        (c.vendor === best.vendor && c.votes === best.votes && c.minProvider < best.minProvider);
      if (better) best = c;
    }
    out.set(id, best.entry);
  }
  return out;
}

// backfillMisses 文档就绪后把「曾 miss 过的模型」重查一次写入第 3 级缓存；
// 查到的清负缓存，查不到的保持 24h 负缓存。
function mdBackfillMisses(): void {
  if (!mdDoc) return;
  for (const m of [...mdNegatives.keys()]) {
    const e = mdDoc.get(m);
    if (!e) continue;
    modelCatalogPut(m, e.context, e.output);
    mdNegatives.delete(m);
  }
}

async function mdFetchDoc(): Promise<void> {
  try {
    const resp = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS) });
    if (resp.status !== 200) return;
    const raw = await resp.text();
    mdDoc = parseModelsDevDoc(raw);
    mdBackfillMisses();
  } catch {
    // 失败静默：只刷新冷却，下次查找仍走 1M 兜底（不重试风暴）。
  }
}

// ensureDocAsync 确保文档索引可用（异步，不阻塞调用方）：
// 已有索引 / 冷却期内 / 已有人在拉（in-flight 去重）→ 直接返回。
function mdEnsureDocAsync(): void {
  if (mdDoc) return;
  const now = Date.now();
  if (mdFetched && now - mdLastFetch < MODELS_DEV_FETCH_COOLDOWN_MS) return;
  if (mdInflight) return;
  mdFetched = true;
  mdLastFetch = now;
  mdInflight = mdFetchDoc().finally(() => {
    mdInflight = null;
  });
}

// ---------- 四级查找链（对 /v1/models 暴露的入口） ----------

// contextWindowListingV4 四级查找的 context_length 决策：
//   1. remote>0 权威透出（上游动态值永远优先）；
//   2. 静态种子表；
//   3. 进程内缓存（内含种子初值 / models.dev 运行时补充值）；
//   4. 全链 miss 且非负缓存 → 异步触发 models.dev 拉取（本次返回 1M，不阻塞）。
export function contextWindowListing(model: string, remote: number): number {
  if (remote > 0) return remote;
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  const cap = CONTEXT_CAP_FALLBACK[model];
  if (cap && cap.context > 0) return cap.context; // 第 2 级
  const e = modelCatalogGet(model);
  if (e) return e.contextLength; // 第 3 级
  if (!mdNegativeFresh(model)) {
    const hit = mdLookup(model);
    if (hit) {
      modelCatalogPut(model, hit.context, hit.output);
      return hit.context;
    }
    mdEnsureDocAsync();
  }
  return DEFAULT_CONTEXT_WINDOW; // 第 4 级兜底：1M（宁可高估不低估）
}

// maxOutputTokensListingV4 四级查找的 max_output_tokens 决策：
// 未知 → undefined（调用方省略字段；与 context 的 1M 兜底刻意不同，输出上限不编造）。
export function maxOutputTokensListing(model: string, remote: number): number | undefined {
  if (remote > 0) return remote;
  if (!model) return undefined;
  const cap = CONTEXT_CAP_FALLBACK[model];
  if (cap && cap.maxOutput > 0) return cap.maxOutput; // 第 2 级
  const e = modelCatalogGet(model);
  if (e && e.maxOutputTokens > 0) return e.maxOutputTokens; // 第 3 级
  if (!mdNegativeFresh(model)) {
    const hit = mdLookup(model);
    if (hit) {
      modelCatalogPut(model, hit.context, hit.output);
      return hit.output > 0 ? hit.output : undefined;
    }
    mdEnsureDocAsync();
  }
  return undefined; // 第 4 级兜底：省略
}

// ---------- 限时优惠（/v3/config data.modelPromotions） ----------

export interface V3ModelPromotion {
  enabled?: boolean;
  priority?: number;
  modelIds?: string[];
  badge?: { label?: string } | null;
  discount?: { discountedCredits?: string; factor?: number } | null;
  hover?: { textZh?: string } | null;
  schedule?: {
    daily?: { start?: string; end?: string }[];
    timezone?: string;
    validFrom?: string;
    validUntil?: string;
  } | null;
}

// promoClock 解析 "HH:MM" 为当日分钟数；坏值返回 -1。
function promoClock(hhmm: string): number {
  const parts = (hhmm ?? "").split(":");
  if (parts.length !== 2) return -1;
  const h = Number(parts[0].trim());
  const m = Number(parts[1].trim());
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 24 || m < 0 || m > 59) return -1;
  return h * 60 + m;
}

// shanghaiNow 把 now 换算到 Asia/Shanghai 墙钟（UTC+8 无夏令时，对齐 Go tz.Beijing）。
function shanghaiMinutes(now: Date): { dayMinutes: number; now: Date } {
  const sh = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
  return { dayMinutes: sh.getHours() * 60 + sh.getMinutes(), now: sh };
}

// promoActive 评估优惠在 now 是否生效：enabled + validFrom/validUntil 内 + 落在任一
// daily 窗口（支持跨午夜，如 23:00→7:50）。schedule 为 null 视为全天生效。
export function promoActive(p: V3ModelPromotion, now: Date): boolean {
  if (!p.enabled) return false;
  const sc = p.schedule;
  if (sc) {
    if (sc.validFrom) {
      const from = Date.parse(sc.validFrom);
      if (!Number.isNaN(from) && now.getTime() < from) return false;
    }
    if (sc.validUntil) {
      const until = Date.parse(sc.validUntil);
      if (!Number.isNaN(until) && now.getTime() >= until) return false;
    }
    if (sc.daily && sc.daily.length > 0) {
      const { dayMinutes } = shanghaiMinutes(now);
      let inWindow = false;
      for (const w of sc.daily) {
        const st = promoClock(w.start ?? "");
        const ed = promoClock(w.end ?? "");
        if (st < 0 || ed < 0) continue;
        if (st <= ed) {
          if (dayMinutes >= st && dayMinutes < ed) {
            inWindow = true;
            break;
          }
        } else if (dayMinutes >= st || dayMinutes < ed) {
          // 跨午夜（23:00→7:50）
          inWindow = true;
          break;
        }
      }
      if (!inWindow) return false;
    }
  }
  return true;
}

// applyModelPromotions 把当前生效的优惠挂到目录条目：同模型多条命中取 priority 最高。
// 无 discount 的条目也挂标签/说明（错峰类），promoFactor 留 undefined。
export function applyModelPromotions(out: Map<string, ModelInfoFull>, promos: V3ModelPromotion[]): void {
  if (promos.length === 0 || out.size === 0) return;
  const now = new Date();
  const best = new Map<string, { prio: number; p: V3ModelPromotion }>();
  for (const p of promos) {
    if (!promoActive(p, now)) continue;
    for (const id of p.modelIds ?? []) {
      if (!out.has(id)) continue; // 目录外模型不挂
      const prio = p.priority ?? 0;
      const b = best.get(id);
      if (!b || prio > b.prio) best.set(id, { prio, p });
    }
  }
  for (const [id, c] of best) {
    const mi = out.get(id)!;
    if (c.p.badge?.label) mi.promoLabel = c.p.badge.label;
    if (c.p.hover?.textZh) mi.promoNote = c.p.hover.textZh;
    if (c.p.discount) {
      mi.promoFactor = c.p.discount.factor;
      mi.promoCredits = c.p.discount.discountedCredits;
    }
  }
}

// ---------- /v3/config 拉取（官方 IDE 配置目录） ----------

// v3ConfigDomain /v3/config 的 X-Domain：优先账号落盘 domain，否则 chatBase host。
function v3ConfigDomain(a: AuthShape, chatBaseUrl: string): string {
  let d = (a.domain ?? "").trim();
  if (d) {
    d = d.replace(/^https?:\/\//, "");
    return d.replace(/\/+$/, "");
  }
  try {
    const u = new URL(chatBaseUrl);
    if (u.host) return u.host;
  } catch {
    // fallthrough
  }
  return "copilot.tencent.com";
}

// fetchV3ConfigModelMap 拉官方 IDE 配置目录，按模型 id 建能力表。
// 该端点对 UA 敏感：必须带 CodeBuddy/CodeBuddyIDE 版本号，否则 400 code=12403；
// 且不同 UA 下发不同模型集合（见 UA 常量注释）。ua 空串等价 CODEBUDDY_IDE_UA。
export async function fetchV3ConfigModelMap(
  cfg: AppConfig,
  a: AuthShape,
  ua: string,
): Promise<Map<string, ModelInfoFull>> {
  const base = chatBaseOf(a);
  const resp = await fetch(base + "/v3/config", {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest",
      Authorization: "Bearer " + a.accessToken,
      ...(a.uid ? { "X-User-Id": a.uid } : {}),
      "X-Domain": v3ConfigDomain(a, base),
      "X-Product": "SaaS",
      "User-Agent": ua || CODEBUDDY_IDE_UA,
      "X-CodeBuddy-Request": "1",
    },
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await resp.text();
  if (resp.status !== 200) {
    throw new Error(`v3/config status ${resp.status}: ${trunc(raw, 120)}`);
  }
  // ProductFeaturesConfig 内嵌键上游用大写开头（对齐 Go `json:"ModelTrialBanner"`）。
  interface V3Env {
    code?: number;
    data?: {
      models?: DynEntry[];
      productFeaturesConfig?: {
        ModelTrialBanner?: { banners?: { modelId?: string; targetModelId?: string }[] };
      };
      modelPromotions?: V3ModelPromotion[];
    };
    ProductFeaturesConfig?: {
      ModelTrialBanner?: { banners?: { modelId?: string; targetModelId?: string }[] };
    };
  }
  let env: V3Env;
  try {
    env = JSON.parse(raw);
  } catch {
    throw new Error("v3/config parse failed");
  }
  if (env.code !== 0) throw new Error(`v3/config code=${env.code}`);
  const out = new Map<string, ModelInfoFull>();
  for (const m of env.data?.models ?? []) {
    if (!m.id || !m.id.trim()) continue;
    out.set(m.id, dynToModelInfo(m));
  }
  // 补入试用横幅模型（ModelTrialBanner）：上游把「N 天免费试用」的模型只放在这里。
  // 能力字段从 targetModelId 既有条目继承；credits 与 tags 显式清空（它们描述转正
  // 后的计费与营销信息，用在免费试用版上会误导下游展示）。
  const banners =
    env.data?.productFeaturesConfig?.ModelTrialBanner?.banners ??
    env.ProductFeaturesConfig?.ModelTrialBanner?.banners ??
    [];
  for (const b of banners) {
    const id = (b.modelId ?? "").trim();
    if (!id || out.has(id)) continue;
    let mi: ModelInfoFull = { id, contextWindow: 0, maxTokens: 0 };
    const tgt = (b.targetModelId ?? "").trim();
    if (tgt && out.has(tgt)) {
      mi = { ...out.get(tgt)!, id };
    }
    mi.credits = undefined;
    mi.tags = undefined;
    out.set(id, mi);
  }
  // 挂当前生效的限时优惠（credits 是牌价，promo* 是生效价）。
  applyModelPromotions(out, env.data?.modelPromotions ?? []);
  if (out.size === 0) throw new Error("v3/config returned empty models");
  return out;
}

function chatBaseOf(a: AuthShape): string {
  return a.realm === "global" ? GLOBAL_BASE : CHAT_BASE_CN;
}

// ---------- 企业端点（/console/enterprises/personal/models，agents[cli] 过滤） ----------

// fetchEnterpriseModels 单路探测企业模型端点：
// agents[cli].models 过滤 + nonChatModel 剔除 + disabled 剔除。
export async function fetchEnterpriseModels(
  cfg: AppConfig,
  a: AuthShape,
): Promise<ModelInfoFull[]> {
  const resp = await fetch(chatBaseOf(a) + "/console/enterprises/personal/models", {
    method: "GET",
    headers: { ...commonHeaders(cfg, a), Authorization: "Bearer " + a.accessToken },
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await resp.text();
  if (resp.status !== 200) {
    throw new Error(`models api status ${resp.status}: ${trunc(raw, 120)}`);
  }
  let env: {
    code?: number;
    data?: {
      models?: DynEntry[];
      agents?: { name?: string; models?: string[] }[];
    };
  };
  try {
    env = JSON.parse(raw);
  } catch {
    throw new Error("models parse failed");
  }
  if (env.code !== 0) throw new Error(`models api code=${env.code}`);
  const cliIDs = env.data?.agents?.find((ag) => ag.name === "cli")?.models ?? [];
  if (cliIDs.length === 0) throw new Error("no cli agent models found");
  const dynMap = new Map<string, DynEntry>();
  for (const m of env.data?.models ?? []) {
    if (nonChatModel(m.id ?? "", m.maxOutputTokens ?? 0, m.tags)) continue;
    if (m.id) dynMap.set(m.id, m);
  }
  const out: ModelInfoFull[] = [];
  for (const id of cliIDs) {
    const m = dynMap.get(id);
    if (m && !m.disabled) out.push(dynToModelInfo(m));
  }
  if (out.length === 0) throw new Error("models api returned empty list");
  return out;
}

// mergeModelInfos 合并两路模型目录：primary 为主（同 id 以 primary 条目为准），
// secondary 只补 primary 缺失的 id；输出顺序 = primary 原序 + secondary 补充项原序。
export function mergeModelInfos(primary: ModelInfoFull[], secondary: ModelInfoFull[]): ModelInfoFull[] {
  if (secondary.length === 0) return primary;
  const seen = new Set<string>();
  const out: ModelInfoFull[] = [];
  for (const mi of primary) {
    if (!mi.id || seen.has(mi.id)) continue;
    seen.add(mi.id);
    out.push(mi);
  }
  for (const mi of secondary) {
    if (!mi.id || seen.has(mi.id)) continue;
    seen.add(mi.id);
    out.push(mi);
  }
  return out;
}

// ---------- effort 能力桶（realm 分桶；探测下发权威写入） ----------

interface EffortBucket {
  efforts: Map<string, string[]>;
  defaults: Map<string, string>;
}

const effortBuckets = new Map<string, EffortBucket>(); // key: "cn" | "global"

const effortRealmKey = (realm: string) => (realm === "" ? "cn" : realm);

// storeEfforts 按 realm 写入 effort 能力桶（CN FetchModels 与 global 探测共用）。
// efforts 与 defs 均空时删除该 realm 桶（等价「该域无可降级档位」）；
// 调用方负责在「无新数据」时跳过写。
export function storeEfforts(
  realm: string,
  efforts: Record<string, string[]>,
  defs: Record<string, string>,
): void {
  const k = effortRealmKey(realm);
  if (Object.keys(efforts).length === 0 && Object.keys(defs).length === 0) {
    effortBuckets.delete(k);
    return;
  }
  effortBuckets.set(k, { efforts: new Map(Object.entries(efforts)), defaults: new Map(Object.entries(defs)) });
}

// effortsSnapshot 导出指定 realm 的探测下发 effort 桶（原始远端值，不合静态表）。
// 桶未填充 → 两个空对象。
export function effortsSnapshot(realm: string): {
  efforts: Record<string, string[]>;
  defaults: Record<string, string>;
} {
  const b = effortBuckets.get(effortRealmKey(realm));
  if (!b) return { efforts: {}, defaults: {} };
  return { efforts: Object.fromEntries(b.efforts), defaults: Object.fromEntries(b.defaults) };
}

function extractEffortsFromInfos(infos: ModelInfoFull[]): {
  efforts: Record<string, string[]>;
  defaults: Record<string, string>;
} {
  const efforts: Record<string, string[]> = {};
  const defaults: Record<string, string> = {};
  for (const mi of infos) {
    if (!mi.id) continue;
    if (mi.efforts && mi.efforts.length > 0) efforts[mi.id] = mi.efforts;
    if (mi.defaultEffort) defaults[mi.id] = mi.defaultEffort;
  }
  return { efforts, defaults };
}

// ---------- CN 域双路探测入口（v3 主 + 企业补缺，allSettled 独立容错） ----------

// fetchModelsFull CN 动态目录：/v3/config（主，IDE UA 完整能力版）+ 企业端点
// （/console，cli 面过滤，补缺）的并集，两路并发、独立容错、v3 条目优先。
// 两路全失败 → 抛企业端点错误（既有调用方语义零漂移）。成功刷新 effort 桶。
export async function fetchModelsFull(cfg: AppConfig, a: AuthShape): Promise<ModelInfoFull[]> {
  const [v3, enterprise] = await Promise.allSettled([
    (async () => {
      const byID = await fetchV3ConfigModelMap(cfg, a, CODEBUDDY_IDE_UA);
      const out: ModelInfoFull[] = [];
      for (const mi of byID.values()) {
        if (nonChatModel(mi.id, mi.maxTokens, mi.tags)) continue;
        out.push(mi);
      }
      if (out.length === 0) throw new Error("v3/config returned empty models");
      return out;
    })(),
    fetchEnterpriseModels(cfg, a),
  ]);
  if (v3.status === "rejected" && enterprise.status === "rejected") {
    throw enterprise.reason instanceof Error ? enterprise.reason : new Error(String(enterprise.reason));
  }
  const v3Infos = v3.status === "fulfilled" ? v3.value : [];
  const entInfos = enterprise.status === "fulfilled" ? enterprise.value : [];
  const out = mergeModelInfos(v3Infos, entInfos);
  if (out.length === 0) throw new Error("models api returned empty list");
  // 刷新 effort 能力缓存：空桶时跳过写（避免「某探测无档位数据」清掉既有桶）；
  // 按探测账号 realm 写对应桶（CN 探测只进 cn 桶，global 同模型名不被污染）。
  const { efforts, defaults } = extractEffortsFromInfos(out);
  if (Object.keys(efforts).length > 0 || Object.keys(defaults).length > 0) {
    storeEfforts(a.realm || "cn", efforts, defaults);
  }
  return out;
}

// ---------- global 域四路探测（纯动态：拉不出即空名单，无静态回落） ----------

// GLOBAL_MODELS_PROBE_PATHS 企业模型目录端点候选序列：/v2 家族优先，/console 兜底。
const GLOBAL_MODELS_PROBE_PATHS = [
  "/v2/enterprises/personal/models",
  "/console/enterprises/personal/models",
];

const GLOBAL_MODELS_TTL_MS = 3600_000; // 成功缓存 1h
const GLOBAL_MODELS_FAIL_COOLDOWN_MS = 5 * 60_000; // 失败 5min 负缓存

interface GlobalModelsCache {
  names: string[] | null;
  infos: ModelInfoFull[] | null;
  fetched: number;
  lastFail: number;
}

const globalModelsCache: GlobalModelsCache = { names: null, infos: null, fetched: 0, lastFail: 0 };

// resolveGlobalModelsArray 从 payload 定位模型数组：payload 本身是数组直接用；
// 是 map 则依次尝试 models/items/list/data/result 键（递归下钻）。
function resolveGlobalModelsArray(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!isObj(payload)) return null;
  for (const key of ["models", "items", "list", "data", "result"]) {
    const nested = resolveGlobalModelsArray(payload[key]);
    if (nested) return nested;
  }
  return null;
}

// parseGlobalModelLoose 单模型对象的宽松解析：id 依次回退 id/modelId/model/name；
// 窗口键回退 contextWindow/maxTokens；reasoning 档位 defaultEffort 新键优先、
// effort 老键兜底。disabled 剔除。credits 恒不解析（倍率不进 global 路径）。
export function parseGlobalModelLoose(obj: Obj): ModelInfoFull | null {
  const str = (key: string) => {
    const v = obj[key];
    return typeof v === "string" ? v.trim() : "";
  };
  let id = str("id");
  for (const k of ["modelId", "model", "name"]) {
    if (id) break;
    id = str(k);
  }
  if (!id) return null;
  if (obj["disabled"] === true) return null;
  const num = (...keys: string[]): number => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "number" && v > 0) return Math.floor(v);
    }
    return 0;
  };
  const mi: ModelInfoFull = {
    id,
    name: str("name") || undefined,
    contextWindow: num("maxInputTokens", "contextWindow"),
    maxTokens: num("maxOutputTokens", "maxTokens"),
    maxAllowedSize: num("maxAllowedSize") || undefined,
  };
  if (obj["supportsReasoning"] === true) mi.supportsReasoning = true;
  if (obj["supportsImages"] === true) mi.supportsImages = true;
  if (isObj(obj["reasoning"])) {
    const r = obj["reasoning"];
    const rstr = (key: string) => {
      const v = r[key];
      return typeof v === "string" ? v.trim() : "";
    };
    mi.defaultEffort = rstr("defaultEffort") || rstr("effort") || undefined;
    if (r["canDisableThinking"] === true) mi.canDisableThinking = true;
    if (Array.isArray(r["supportedEfforts"])) {
      const arr = (r["supportedEfforts"] as unknown[])
        .filter((v): v is string => typeof v === "string" && v.trim() !== "")
        .map((v) => v.trim());
      if (arr.length > 0) mi.efforts = arr;
    }
  }
  return mi;
}

// parseGlobalModelNames 多信封兼容解析模型目录：
//   - 信封：code 存在且非 0 才拒；payload = data（非空非 null 时）否则整包；
//   - 数组定位：payload 本身是数组，或 models/items/list/data/result 递归下钻；
//   - 主形态：对象数组按 DynEntry 全字段解析（id 回退 modelId/model/name，disabled 剔除）；
//   - 窄表：字符串数组 → 仅 ID；
//   - 动态兜底：逐对象宽松解析（上游换键名时不至于整域空列表）。
// 返回 null = 解析失败 / 空名单。
export function parseGlobalModelNames(raw: string): {
  names: string[];
  infos: ModelInfoFull[] | null;
  efforts: Record<string, string[]>;
  defaults: Record<string, string>;
} | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(envelope) && !Array.isArray(envelope)) return null;
  if (isObj(envelope)) {
    const code = envelope["code"];
    if (typeof code === "number" && code !== 0) return null;
  }
  let payload: unknown = envelope;
  if (isObj(envelope)) {
    const data = envelope["data"];
    if (data !== undefined && data !== null) payload = data;
  }
  const arr = resolveGlobalModelsArray(payload);
  if (!arr) return null;
  const efforts: Record<string, string[]> = {};
  const defaults: Record<string, string> = {};

  // 主形态：对象数组（DynEntry）。
  if (arr.length > 0 && arr.every((v) => isObj(v))) {
    const names: string[] = [];
    const infos: ModelInfoFull[] = [];
    for (const v of arr as Obj[]) {
      const m = v as DynEntry & Obj;
      let id = m.id ?? m.modelId ?? m.model ?? "";
      if (!id && typeof m.name === "string") id = m.name; // name 兜底（对齐 Go 回退链）
      id = id.trim();
      if (!id || m.disabled) continue;
      names.push(id);
      const mi = dynToModelInfo(m);
      mi.id = id;
      // 宽松键回退：maxInputTokens/maxOutputTokens 缺省时试 contextWindow/maxTokens
      // （对齐 Go dynModelEntry 宽松解析 —— 国际站曾在多种 envelope 间切换键名）。
      if (!mi.contextWindow && typeof m.contextWindow === "number" && m.contextWindow > 0) {
        mi.contextWindow = Math.floor(m.contextWindow);
      }
      if (!mi.maxTokens && typeof m.maxTokens === "number" && m.maxTokens > 0) {
        mi.maxTokens = Math.floor(m.maxTokens);
      }
      if (!mi.maxAllowedSize && typeof m.maxAllowedSize === "number" && m.maxAllowedSize > 0) {
        mi.maxAllowedSize = Math.floor(m.maxAllowedSize);
      }
      infos.push(mi);
      if (m.reasoning?.supportedEfforts && m.reasoning.supportedEfforts.length > 0) {
        efforts[id] = m.reasoning.supportedEfforts;
      }
      const d = m.reasoning?.defaultEffort ?? m.reasoning?.effort;
      if (d) defaults[id] = d;
    }
    if (names.length > 0) return { names, infos, efforts, defaults };
  }

  // 窄表：纯字符串数组 → 仅 ID（无元数据 → infos null）。
  if (arr.length > 0 && arr.every((v) => typeof v === "string")) {
    const names = (arr as string[]).map((s) => s.trim()).filter(Boolean);
    if (names.length > 0) return { names, infos: null, efforts: {}, defaults: {} };
    return null;
  }

  // 动态兜底：逐对象宽松解析（混合数组里的裸 ID 按窄表条目处理）。
  const names: string[] = [];
  const infos: ModelInfoFull[] = [];
  for (const item of arr) {
    if (typeof item === "string") {
      const id = item.trim();
      if (id) {
        names.push(id);
        infos.push({ id, contextWindow: 0, maxTokens: 0 });
      }
    } else if (isObj(item)) {
      const mi = parseGlobalModelLoose(item);
      if (!mi) continue;
      names.push(mi.id);
      infos.push(mi);
      if (mi.efforts && mi.efforts.length > 0) efforts[mi.id] = mi.efforts;
      if (mi.defaultEffort) defaults[mi.id] = mi.defaultEffort;
    }
  }
  if (names.length === 0) return null;
  return { names, infos, efforts, defaults };
}

// globalModelsOnce 单端点探测（企业端点家族路径之一）。
async function globalModelsOnce(
  cfg: AppConfig,
  a: AuthShape,
  path: string,
): Promise<{ names: string[]; infos: ModelInfoFull[] | null; efforts: Record<string, string[]>; defaults: Record<string, string> }> {
  const resp = await fetch(chatBaseOf(a) + path, {
    method: "GET",
    headers: { ...commonHeaders(cfg, a), Authorization: "Bearer " + a.accessToken },
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await resp.text();
  if (resp.status !== 200) {
    throw new Error(`global models status ${resp.status}: ${trunc(raw, 120)}`);
  }
  const parsed = parseGlobalModelNames(raw);
  if (!parsed) throw new Error("global models empty list");
  return parsed;
}

// mergeGlobalCatalog 两路合并（v3 主、企业补缺）：names 按 id 去重（v3 原序在前、
// 企业补充项在后）；infos 同步合并（v3 条目字段权威）。窄表形态 infos 保持 null。
function mergeGlobalCatalog(
  primaryNames: string[],
  primaryInfos: ModelInfoFull[] | null,
  secondaryNames: string[],
  secondaryInfos: ModelInfoFull[] | null,
): { names: string[]; infos: ModelInfoFull[] | null } {
  if (secondaryNames.length === 0) return { names: primaryNames, infos: primaryInfos };
  const seen = new Set<string>();
  const names: string[] = [];
  for (const id of primaryNames) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    names.push(id);
  }
  let infos = primaryInfos ? [...primaryInfos] : null;
  for (const id of secondaryNames) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    names.push(id);
    const mi = secondaryInfos?.find((x) => x.id === id);
    if (mi) {
      if (!infos) infos = [];
      infos.push(mi);
    }
  }
  return { names, infos };
}

function mergeEffortBuckets(
  primary: Record<string, string[]>,
  secondary: Record<string, string[]>,
): Record<string, string[]> {
  const out = { ...primary };
  for (const [id, v] of Object.entries(secondary)) {
    if (!(id in out)) out[id] = v;
  }
  return out;
}

function mergeEffortDefaults(
  primary: Record<string, string>,
  secondary: Record<string, string>,
): Record<string, string> {
  const out = { ...primary };
  for (const [id, v] of Object.entries(secondary)) {
    if (!(id in out)) out[id] = v;
  }
  return out;
}

// probeGlobalModels 发起一次 global 模型目录探测：/v3/config 三路 UA（桌面端主路 +
// IDE + CLI）与企业端点家族（/v2 → /console 兜底）并发后并集合并。
// 三路 UA 缺一不可（实测同一 global 账号不同 UA 拿到不同模型集合）；
// 合并口径：桌面端条目字段权威，IDE/CLI 只补桌面端缺失的模型 id。
// 全部 v3 路失败且企业端点也失败才抛错；单路失败降级为其余路结果。
async function probeGlobalModels(
  cfg: AppConfig,
  a: AuthShape,
): Promise<{
  names: string[];
  infos: ModelInfoFull[] | null;
  efforts: Record<string, string[]>;
  defaults: Record<string, string>;
}> {
  const probeV3 = async (ua: string) => {
    const byID = await fetchV3ConfigModelMap(cfg, a, ua);
    const names: string[] = [];
    const infos: ModelInfoFull[] = [];
    for (const mi of byID.values()) {
      if (nonChatModel(mi.id, mi.maxTokens, mi.tags)) continue;
      names.push(mi.id);
      infos.push(mi);
    }
    names.sort(); // map 迭代序随机，排序保输出稳定
    return { names, infos };
  };
  const desktopUA = `WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1`;
  const [v3Desktop, v3IDE, v3CLI, enterprise] = await Promise.allSettled([
    probeV3(desktopUA),
    probeV3(CODEBUDDY_IDE_UA),
    probeV3(CODEBUDDY_CLI_UA),
    (async () => {
      let lastErr: unknown = new Error("no probe path");
      for (const path of GLOBAL_MODELS_PROBE_PATHS) {
        try {
          return await globalModelsOnce(cfg, a, path);
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr;
    })(),
  ]);

  // v3 三路按权威序合并：桌面端 > IDE > CLI（前序路字段权威，后续路只补缺失 id）。
  let v3: { names: string[]; infos: ModelInfoFull[] } | null = null;
  for (const r of [v3Desktop, v3IDE, v3CLI]) {
    if (r.status !== "fulfilled") continue;
    if (!v3) {
      v3 = r.value;
    } else {
      const merged = mergeGlobalCatalog(v3.names, v3.infos, r.value.names, r.value.infos);
      v3 = { names: merged.names, infos: merged.infos ?? v3.infos };
    }
  }

  if (!v3 && enterprise.status === "rejected") {
    throw enterprise.reason instanceof Error ? enterprise.reason : new Error(String(enterprise.reason));
  }
  if (!v3) {
    // /v3 全失败降级：仅企业端点结果。
    const ent = (enterprise as PromiseFulfilledResult<{
      names: string[];
      infos: ModelInfoFull[] | null;
      efforts: Record<string, string[]>;
      defaults: Record<string, string>;
    }>).value;
    return { names: ent.names, infos: ent.infos, efforts: ent.efforts, defaults: ent.defaults };
  }
  const { efforts: v3Efforts, defaults: v3Defaults } = extractEffortsFromInfos(v3.infos);
  if (enterprise.status === "rejected") {
    return { names: v3.names, infos: v3.infos, efforts: v3Efforts, defaults: v3Defaults };
  }
  // 两路皆成功：v3 为主、企业端点补缺合并（含 effort 桶合并，v3 权威）。
  const ent = enterprise.value;
  const merged = mergeGlobalCatalog(v3.names, v3.infos, ent.names, ent.infos);
  return {
    names: merged.names,
    infos: merged.infos,
    efforts: mergeEffortBuckets(v3Efforts, ent.efforts),
    defaults: mergeEffortDefaults(v3Defaults, ent.defaults),
  };
}

// fetchGlobalModelInfosOnce 单次探测决策（缓存命中/负缓存/触发探测）。
// 纯动态：成功 = 并集结果去重；一切失败 = 空名单（不回落静态）。
async function fetchGlobalModelInfosOnce(
  cfg: AppConfig,
  a: AuthShape,
): Promise<{ names: string[]; infos: ModelInfoFull[] | null }> {
  const now = Date.now();
  if (globalModelsCache.names && now - globalModelsCache.fetched < GLOBAL_MODELS_TTL_MS) {
    return { names: globalModelsCache.names, infos: globalModelsCache.infos };
  }
  if (globalModelsCache.lastFail > 0 && now - globalModelsCache.lastFail < GLOBAL_MODELS_FAIL_COOLDOWN_MS) {
    return { names: [], infos: null };
  }
  try {
    const { names, infos, efforts, defaults } = await probeGlobalModels(cfg, a);
    if (names.length === 0) throw new Error("global models empty list");
    // global 域 effort 能力：探测下发权威写入 global 桶（raw remote，不并入静态表——
    // 静态兜底在 prepareBody 的 globalEffortMap 与 /v1/models 的 effortListing 按需合入）。
    if (Object.keys(efforts).length > 0 || Object.keys(defaults).length > 0) {
      storeEfforts("global", efforts, defaults);
    }
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const id of names) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
    }
    globalModelsCache.names = merged;
    globalModelsCache.infos = infos;
    globalModelsCache.fetched = Date.now();
    globalModelsCache.lastFail = 0;
    return { names: merged, infos };
  } catch {
    globalModelsCache.lastFail = Date.now();
    globalModelsCache.names = null;
    globalModelsCache.infos = null;
    return { names: [], infos: null };
  }
}

// fetchGlobalModelInfos 探测 global 账号的模型目录（1h 缓存 + 5min 失败负缓存）。
// 窄表形态 / 探测失败 / 负缓存 → infos 为 null（调用方按裸 ID 输出，不编造字段）。
export async function fetchGlobalModelInfos(
  cfg: AppConfig,
  a: AuthShape,
): Promise<{ names: string[]; infos: ModelInfoFull[] | null }> {
  if (a.realm !== "global") return { names: [], infos: null };
  return fetchGlobalModelInfosOnce(cfg, a);
}
