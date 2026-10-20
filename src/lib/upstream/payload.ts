// payload.ts 出站 chat 请求体改写管线（移植 internal/upstream/payload.go
// PrepareBodyOptWithEffortsAndDefault + effort_catalog.go + thinking.go 调用侧）。
//
// 管线顺序与 Go 逐字对齐，顺序不可换：
//   1. 强制 stream:true（上游拒绝非流式）
//   2. max_completion_tokens → max_tokens 翻译（OpenAI 新别名，上游只认 max_tokens）
//   3. GPT 系 max_tokens 下限抬升（<16 上游 400 code=11133）
//   4. stream_options 缺省补 {include_usage:true}（末帧返回 usage）
//   5. tool_choice 归一化（上游该字段是 string，对象形态 400 code=11101）
//   6. tools pattern 非标准转义 \_ → _ 归一化（上游严格正则文法 400 code=11129）
//   7. role developer → system（上游 role 白名单 400 code=11-128）
//   8. image_url 字符串 → 对象形态（字符串形态 400 code=11101）
//   9. tool 配对三步：mergeAdjacent → repack → cleanup（上游 11148 配对断裂）
//  10. deepseek 思维链注入 thinking.type=enabled + 缺档补默认档
//  11. reasoning_effort 按模型 supportedEfforts 降级/抬升
//  12. deepseek 多轮一致性：assistant 回填 reasoning_content / reasoning 镜像
//  13. sanitize 指纹脱敏（开关控制，最后执行）
//
// efforts/defaultEfforts 为模型能力缓存（null/undefined = 未知，透传不降级）。

import { sanitizeMessages } from "./sanitize";
import {
  mergeAdjacentToolCalls,
  repackToolResultBlocks,
  cleanupOrphanToolCalls,
} from "./toolPairing";
import { injectThinking, backfillReasoningContent, lookupDefaultEffort } from "./thinking";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// translateMaxCompletionTokens 把 OpenAI 别名 max_completion_tokens 翻译为上游认的
// max_tokens。规则：显式 max_tokens 优先（别名只删）；非正数值/非数值不翻译；
// 无论翻译与否别名一律删（减少 body 体积与排障噪音）。
function translateMaxCompletionTokens(obj: Obj): void {
  if (!("max_completion_tokens" in obj)) return;
  const alias = obj.max_completion_tokens;
  delete obj.max_completion_tokens;
  if ("max_tokens" in obj) return; // 显式 max_tokens 优先
  if (typeof alias === "number" && Number.isInteger(alias) && alias > 0) {
    obj.max_tokens = alias;
  }
}

// GPT 系上游接受的 max_tokens 下限（<16 一律 400 code=11133）。
const GPT_MIN_MAX_TOKENS = 16;

// clampGPTMinMaxTokens 把 GPT 系模型过小的 max_tokens 抬到下限。
// 客户端切模型探针带极小 max_tokens 会被拒 → 模型永远切不过去；抬下限只放宽
// 输出上限、不改语义；未携带/非数值/已达下限不动。
function clampGPTMinMaxTokens(obj: Obj): void {
  const model = typeof obj.model === "string" ? obj.model : "";
  if (!model.toLowerCase().includes("gpt-")) return;
  const v = obj.max_tokens;
  if (typeof v !== "number" || !Number.isFinite(v)) return;
  if (v < GPT_MIN_MAX_TOKENS) {
    obj.max_tokens = GPT_MIN_MAX_TOKENS;
  }
}

// EFFORT_RANK 档位从低到高。
const EFFORT_RANK: Record<string, number> = {
  off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6,
};

// normalizeReasoningEffort 按模型 supportedEfforts 降级 reasoning_effort
// （snake/camel 双字段兼容）。请求档位不支持 → ≤请求档位的最高支持档；
// 支持档全部高于请求档 → 最低支持档；未知模型/未知档位/未携带 → 透传。
export function normalizeReasoningEffort(
  obj: Obj,
  efforts: Record<string, string[]> | null | undefined,
): void {
  if (!efforts || Object.keys(efforts).length === 0) return;
  const model = typeof obj.model === "string" ? obj.model : "";
  if (!model) return;
  const supported = efforts[model];
  if (!supported || supported.length === 0) return;
  let key = "";
  if ("reasoning_effort" in obj) key = "reasoning_effort";
  else if ("reasoningEffort" in obj) key = "reasoningEffort";
  else return;
  const raw = obj[key];
  if (typeof raw !== "string") return;
  const reqStr = raw.trim().toLowerCase();
  const reqIdx = EFFORT_RANK[reqStr];
  if (reqIdx === undefined) return;
  // ≤请求档位的最高支持档。
  let best = "";
  let bestIdx = -1;
  for (const s of supported) {
    const idx = EFFORT_RANK[s.trim().toLowerCase()];
    if (idx !== undefined && idx <= reqIdx && idx > bestIdx) {
      best = s;
      bestIdx = idx;
    }
  }
  if (best !== "") {
    if (best.toLowerCase() !== reqStr) obj[key] = best;
    return;
  }
  // 支持档全部高于请求档：取最低支持档（偏离最小）。
  let lowest = "";
  let lowestIdx = 1 << 30;
  for (const s of supported) {
    const idx = EFFORT_RANK[s.trim().toLowerCase()];
    if (idx !== undefined && idx < lowestIdx) {
      lowest = s;
      lowestIdx = idx;
    }
  }
  if (lowest !== "") obj[key] = lowest;
}

// normalizeRoles 把 messages 里的 developer 角色归一为 system（上游 role 白名单
// 不含 developer，命中即 400 code=11-128）。协议兼容而非内容脱敏，独立于
// sanitize 开关。只认 developer 一个值，其余 role 一律原样保留。
function normalizeRoles(obj: Obj): void {
  if (!Array.isArray(obj.messages)) return;
  for (const m of obj.messages) {
    if (!isObj(m)) continue;
    if (typeof m.role === "string" && m.role.trim().toLowerCase() === "developer") {
      m.role = "system";
    }
  }
}

// normalizeImageURL 兼容 OpenAI 多模态 image_url 的字符串形态：
// 字符串 → {"url": 原值}；已有对象原样保留；空串/非法值不补默认，让上游报真实错。
function normalizeImageURL(obj: Obj): void {
  if (!Array.isArray(obj.messages)) return;
  for (const rawMsg of obj.messages) {
    if (!isObj(rawMsg)) continue;
    const parts = rawMsg.content;
    if (!Array.isArray(parts)) continue;
    for (const rawPart of parts) {
      if (!isObj(rawPart) || rawPart.type !== "image_url") continue;
      const url = rawPart.image_url;
      if (typeof url !== "string" || url === "") continue;
      rawPart.image_url = { url };
    }
  }
}

// normalizeToolChoice 按上游 string 类型字段改写 OpenAI tool_choice：
//   "none" / {"type":"none"}        → 删 tool_choice + 删 tools/functions
//   {"type":"auto"/"required"}      → 字符串 "auto"/"required"
//   {"type":"function","function":{"name":"x"}} → 字符串 "x"（无名回退 "auto"）
//   其他对象/非标量                 → 删 tool_choice
function normalizeToolChoice(obj: Obj): void {
  if (!("tool_choice" in obj)) return;
  const suppress = () => {
    delete obj.tools;
    delete obj.functions;
  };
  const tc = obj.tool_choice;
  if (typeof tc === "string") {
    if (tc.trim().toLowerCase() === "none") {
      delete obj.tool_choice;
      suppress();
    }
    return;
  }
  if (isObj(tc)) {
    const typ = (typeof tc.type === "string" ? tc.type : "").trim().toLowerCase();
    switch (typ) {
      case "none":
        delete obj.tool_choice;
        suppress();
        return;
      case "auto":
      case "required":
        obj.tool_choice = typ;
        return;
      case "function": {
        let name = "";
        if (isObj(tc.function) && typeof tc.function.name === "string") name = tc.function.name;
        if (!name && typeof tc.name === "string") name = tc.name;
        name = name.trim();
        obj.tool_choice = name !== "" ? name : "auto";
        return;
      }
      default:
        delete obj.tool_choice;
        return;
    }
  }
  delete obj.tool_choice;
}

// normalizeToolPatterns 归一化 tools 子树里 pattern 的非标准转义 `\_` → `_`。
// 上游对 tools[].function.parameters 做严格正则文法校验，`\_` 整体拒收
// （400 code=11129）；各主流引擎宽容视为 `_`，归一无损。只动 tools 子树，
// 消息正文不碰。独立于 sanitize 开关（这是「让请求通过」，不是脱敏）。
function normalizeToolPatterns(obj: Obj): void {
  if (!Array.isArray(obj.tools)) return;
  for (const raw of obj.tools) {
    if (!isObj(raw)) continue;
    if (isObj(raw.function)) unescapePatternLiteralEscapes(raw.function.parameters);
    unescapePatternLiteralEscapes(raw.parameters);
  }
}

// unescapePatternLiteralEscapes 递归改写 schema 树里 pattern 值与
// patternProperties 键中的 `\_` → `_`（patternProperties 键也是正则，命中重建该层）。
function unescapePatternLiteralEscapes(node: unknown): void {
  if (Array.isArray(node)) {
    for (const v of node) unescapePatternLiteralEscapes(v);
    return;
  }
  if (!isObj(node)) return;
  if (typeof node.pattern === "string" && node.pattern.includes("\\_")) {
    node.pattern = node.pattern.split("\\_").join("_");
  }
  if (isObj(node.patternProperties)) {
    const props = node.patternProperties;
    let rebuilt = false;
    const fixed: Obj = {};
    for (const k of Object.keys(props)) {
      let nk = k;
      if (k.includes("\\_")) {
        nk = k.split("\\_").join("_");
        rebuilt = true;
      }
      fixed[nk] = props[k];
    }
    if (rebuilt) node.patternProperties = fixed;
  }
  for (const k of Object.keys(node)) unescapePatternLiteralEscapes(node[k]);
}

// ensureConsoleSystem global realm 兜底 system 注入（防 console 域上游 11-128）：
// 首条消息非 system 时在 messages 最前补一条 fallback system。仅 global 调用；
// body 不可解析时原样返回。
export function ensureConsoleSystem(body: string): string {
  if (!body) return body;
  let obj: Obj;
  try {
    obj = JSON.parse(body);
  } catch {
    return body;
  }
  const msgs = obj.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return body;
  const first = msgs[0];
  if (isObj(first)) {
    const role = typeof first.role === "string" ? first.role : "";
    if (role.trim().toLowerCase() === "system") return body; // 首条已是 system
  }
  obj.messages = [{ role: "system", content: "You are a helpful assistant." }, ...msgs];
  try {
    return JSON.stringify(obj);
  } catch {
    return body;
  }
}

// prepareBodyOpt 完整管线入口（对齐 PrepareBodyOptWithEffortsAndDefault）。
// sanitize=false 时跳过指纹脱敏，其余步骤照常执行。
export function prepareBodyOpt(
  src: string,
  sanitize: boolean,
  efforts: Record<string, string[]> | null | undefined,
  defaultEfforts: Record<string, string> | null | undefined,
): string {
  if (!src) return src;
  let obj: Obj;
  try {
    obj = JSON.parse(src);
  } catch {
    return src;
  }
  obj.stream = true;
  translateMaxCompletionTokens(obj);
  clampGPTMinMaxTokens(obj);
  if (!("stream_options" in obj)) {
    obj.stream_options = { include_usage: true };
  }
  normalizeToolChoice(obj);
  normalizeToolPatterns(obj);
  normalizeRoles(obj);
  normalizeImageURL(obj);
  // tool 配对三步（顺序不可换）：先合并背靠背 assistant.tool_calls（11148 正面修复），
  // 再 repack 挪走插在中间的非 tool 消息，最后 cleanup 删孤儿。任一步重排/删除
  // 都必须回写 obj（Go 语义：不能只在「最后一步改动」时回写）。
  if (Array.isArray(obj.messages)) {
    let msgs = obj.messages;
    msgs = mergeAdjacentToolCalls(msgs).out;
    msgs = repackToolResultBlocks(msgs).out;
    msgs = cleanupOrphanToolCalls(msgs).out;
    obj.messages = msgs;
  }
  // DeepSeek 思维链：先于 normalizeReasoningEffort——补入的默认档也要走降级管线。
  const modelName = typeof obj.model === "string" ? obj.model : "";
  injectThinking(obj, lookupDefaultEffort(defaultEfforts, modelName));
  normalizeReasoningEffort(obj, efforts);
  backfillReasoningContent(obj);
  if (sanitize && Array.isArray(obj.messages)) {
    sanitizeMessages(obj.messages);
  }
  try {
    return JSON.stringify(obj);
  } catch {
    return src;
  }
}

// ---------- effort_catalog.go 等价物（产品级静态兜底表，按 realm 分表，绝不混用） ----------

export interface EffortCap {
  efforts: string[];
  defaultEffort?: string;
}

// CN / CodeBuddy 面静态兜底表（对齐 Go effort_catalog.go cnEffortFallback）。
export const CN_EFFORT_FALLBACK: Record<string, EffortCap> = {
  "deepseek-v4-flash": { efforts: ["low", "high", "max"] },
  "deepseek-v4.1-flash": { efforts: ["low", "high", "max"], defaultEffort: "high" },
  "deepseek-v4-pro": { efforts: ["low", "high", "xhigh"], defaultEffort: "high" },
  "hy4-preview": { efforts: ["high"], defaultEffort: "high" },
  "hy4-preview-x": { efforts: ["high"] },
  "hy3": { efforts: ["low", "high"], defaultEffort: "high" },
  "hy3-x": { efforts: ["low", "high"], defaultEffort: "high" },
  "glm-5.3": { efforts: ["low", "high", "max"], defaultEffort: "high" },
  "glm-5.3-flash": { efforts: ["low", "high", "max"], defaultEffort: "high" },
  "glm-5.2": { efforts: ["high", "xhigh"], defaultEffort: "high" },
  "glm-5.1": { efforts: ["medium"] },
  "glm-5v-turbo": { efforts: ["medium"] },
  "kimi-k3-1": { efforts: ["medium"] },
  "kimi-k2.7": { efforts: ["medium"] },
  "kimi-k2.6": { efforts: ["medium"] },
  "minimax-m3": { efforts: ["medium"] },
};

// global / WorkBuddy 国际版面静态兜底表。deepseek-v4.1-flash 国际版只有 ["high"]，
// 与 CN 面三档刻意不同——往 WorkBuddy 上游发 low/max 是非法参数 400。
export const GLOBAL_EFFORT_FALLBACK: Record<string, EffortCap> = {
  "fast-model": { efforts: ["medium"] },
  "balanced-model": { efforts: ["medium"] },
  "primary-model": { efforts: ["high"] },
  "hy4-preview-f": { efforts: ["high"], defaultEffort: "high" },
  "hy3": { efforts: ["low", "high"], defaultEffort: "high" },
  "deepseek-v4.1-flash": { efforts: ["high"] },
  "gpt-6-astra": { efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  "gpt-5.6-sol": { efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  "gpt-5.6-terra": { efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  "gpt-5.6-luna": { efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  "gpt-5.5": { efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
  "gpt-5.4": { efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
  "gpt-5.3-codex": { efforts: ["medium"] },
  "gemini-3.5-flash": { efforts: ["medium"] },
  "glm-5.3": { efforts: ["low", "high", "max"], defaultEffort: "high" },
  "glm-5.2": { efforts: ["high", "xhigh"], defaultEffort: "high" },
  "kimi-k3": { efforts: ["medium"] },
  "kimi-k2.6": { efforts: ["medium"] },
};

// realmKey 归一化缓存键：空 realm 视为 cn（与 Go realmKey 对齐）。
export function realmKey(realm: string): string {
  return realm === "" ? "cn" : realm;
}

// staticEffortCap 按 realm 取静态兜底条目；未命中返回 undefined。
export function staticEffortCap(realm: string, model: string): EffortCap | undefined {
  const table = realmKey(realm) === "global" ? GLOBAL_EFFORT_FALLBACK : CN_EFFORT_FALLBACK;
  return table[model];
}

// globalEffortMap global 域降级用能力表：静态兜底表为基，远端桶覆盖（权威优先）。
// global 上游可能不下发 supportedEfforts，此时也必须按产品静态表降级。
export function globalEffortMap(
  remoteEfforts: Record<string, string[]> | null | undefined,
  remoteDefaults: Record<string, string> | null | undefined,
): { efforts: Record<string, string[]>; defs: Record<string, string> } {
  const efforts: Record<string, string[]> = {};
  const defs: Record<string, string> = {};
  for (const [id, cap] of Object.entries(GLOBAL_EFFORT_FALLBACK)) {
    efforts[id] = [...cap.efforts];
    if (cap.defaultEffort) defs[id] = cap.defaultEffort;
  }
  if (remoteEfforts) {
    for (const [id, v] of Object.entries(remoteEfforts)) {
      if (v.length > 0) efforts[id] = v;
    }
  }
  if (remoteDefaults) {
    for (const [id, v] of Object.entries(remoteDefaults)) {
      if (v !== "") defs[id] = v;
    }
  }
  return { efforts, defs };
}

// effortListing 计算模型在 /v1/models 应暴露的 effort 能力（三级查找）：
// 远端值非空 → 权威；否则静态兜底；皆无 → 空对象（调用方省略字段，不输出空数组）。
// defaultEffort 仅在命中 efforts 时返回（不宣称不支持的默认档）。
export function effortListing(
  realm: string,
  model: string,
  remoteEfforts?: string[],
  remoteDefault?: string,
): { efforts?: string[]; defaultEffort?: string } {
  let src: EffortCap | undefined;
  if (remoteEfforts && remoteEfforts.length > 0) {
    src = { efforts: remoteEfforts, defaultEffort: remoteDefault || undefined };
  } else {
    src = staticEffortCap(realm, model);
  }
  if (!src || src.efforts.length === 0) return {};
  const efforts = [...src.efforts];
  const out: { efforts?: string[]; defaultEffort?: string } = { efforts };
  if (src.defaultEffort && efforts.includes(src.defaultEffort)) {
    out.defaultEffort = src.defaultEffort;
  }
  return out;
}
