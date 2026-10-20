// 错误分类（移植 internal/upstream/client.go 的 ErrKind + Classify）。
// 判定顺序自「严」到「宽」与 Go 逐层对齐，pool 据类别决定冷却/禁用/熔断策略。
export type ErrKind =
  | "none"
  | "hard_credit" // 余额耗尽（402 / 14018 / 计费关键词）→ 冷却到次日 04:00
  | "soft_rate" // 429 软限流 → 对齐上游重置墙钟，封顶 softRateMax
  | "session_dead" // 401+12153 会话失效 → 连续 3 次禁用
  | "account_fault" // 11140 request illegal / 14017 未激活 → 冷却轮换
  | "content_blocked" // 内容审核误报 → 不罚号，网关降级重试
  | "model_blocked" // 11102 该后端无此模型 → (账号,模型) 负缓存
  | "waf_block" // 403 无业务信封（APISIX WAF）→ 软冷却 + IP 状态机
  | "not_found"
  | "server" // 5xx
  | "client" // 其他 4xx
  | "bad_params" // 11101 请求体解析失败 → 不罚号不轮转
  | "image_invalid" // 图片格式/数据无效 → 不罚号不轮转
  | "prompt_too_long"; // 11115 上下文超限 → 不罚号不轮转

export class UpstreamError extends Error {
  kind: ErrKind;
  status: number;
  retryAfterMs: number; // 0 = 上游未明示
  constructor(kind: ErrKind, status: number, msg: string, retryAfterMs = 0) {
    super(msg);
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// 关键词表与 Go 逐字一致（小写比较 + 中文原文双通道）。
const hardMarkers = [
  "insufficient credit", "no credit", "credit exhausted", "credits exhausted", "out of credit",
  "quota exceeded", "quota exhaust", "payment required", "credit not enough",
  "not enough credit",
  "积分不足", "额度不足", "余额不足", "积分用完", "额度用尽", "没有积分",
];

const softRateMarkers = [
  "rate limit", "rate-limiting", "rate-limited",
  "too many requests", "too many",
  "usage limit",
  "请求过于频繁", "限流",
];

const sessionDeadMarkers = ["Offline user session not found", "12153"];

const accountFaultMarkers = [
  "request illegal",
  "trial not activated",
  "trial version is not yet activated",
];

const contentBlockedMarkers = [
  "blocked by security policy",
  "unapproved channel",
  "illegal api invocation",
];

const invalidImageMarkers = [
  "invalid image_url content",
  "invalid_image_data",
  "replace the image",
];

const promptTooLongMarkers = [
  '"code":11115', '"code": 11115', '"code":"11115"',
  "prompt is too long",
];

const badParamsMarkerMsg = "Unmarshal chat params failed";
const badParamsMarkerCode = '"code":11101';

export const alreadyCheckinMarkers = ["已签到", "already"];

// buddyTaskIncompleteMarker 领养门槛未达标的业务错误关键词（HTTP 400 时出现）。
export const buddyTaskIncompleteMarker = "first_buddy task not completed yet";

// 6004 模型级限流业务码：`"code":6004`（JSON 空格容差）。
const reModelRateLimit = /"code"\s*:\s*"?6004"?/;

export function isModelRateLimit(body: string): boolean {
  return reModelRateLimit.test(body);
}

const MODEL_BLOCK_CODE = "11102";
const MODEL_BLOCK_MSG = "service info not found";
export const MODEL_BLOCK_REASON = "11102 model not available";

// isModelBlocked：11102 确定性答复（只认 400/404；只比对 code/msg 独立字段）。
export function isModelBlocked(status: number, body: string): boolean {
  if ((status !== 400 && status !== 404) || !body) return false;
  if (!body.includes(MODEL_BLOCK_CODE) && !body.toLowerCase().includes(MODEL_BLOCK_MSG)) {
    return false;
  }
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(body);
  } catch {
    return false;
  }
  const nodes: Record<string, unknown>[] = [root];
  const inner = root["error"];
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    nodes.push(inner as Record<string, unknown>);
  }
  let code = "";
  let msg = "";
  for (const node of nodes) {
    for (const key of ["code", "errCode", "error_code"]) {
      const v = node[key];
      if (v != null && code === "") code = String(v).trim();
    }
    for (const key of ["msg", "message"]) {
      const v = node[key];
      if (typeof v === "string" && v !== "" && msg === "") msg = v.trim();
    }
  }
  if (code === MODEL_BLOCK_CODE) return true;
  return msg.toLowerCase().includes(MODEL_BLOCK_MSG);
}

function hasBusinessCode(body: string, want: string): boolean {
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    return false;
  }
  const walk = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(walk);
    if (value && typeof value === "object") {
      const node = value as Record<string, unknown>;
      if ("code" in node && String(node.code).trim() === want) return true;
      return Object.values(node).some(walk);
    }
    return false;
  };
  return walk(root);
}

// 业务信封存在性（WAF 403 判定的反向依据）。
function hasBusinessEnvelope(body: string): boolean {
  return body.includes('"code":') || body.includes('"msg":');
}

export function isWafBlocked(status: number, body: string): boolean {
  return status === 403 && !hasBusinessEnvelope(body);
}

function isPromptTooLongStatus(status: number): boolean {
  return status === 400 || status === 404 || status === 413;
}

// 限流重置文案（上游固定 UTC+8）：CN「将在 … 重置」/ EN "reset at ..."。
const reResetCN = /将在 (.+?) 重置/;
const reResetEN = /reset at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/i;

// parseRateReset 解析「将在 … 重置」墙钟（UTC+8 解释），返回 unix 毫秒；失败 0。
export function parseRateReset(body: string): number {
  const m = reResetCN.exec(body) ?? reResetEN.exec(body);
  if (!m) return 0;
  let ts = m[1].trim();
  if (ts.endsWith(" UTC+8")) ts = ts.slice(0, -6);
  const m2 = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(ts);
  if (!m2) return 0;
  const [, y, mo, d, h, mi, s] = m2;
  // 固定按 UTC+8 解释：拼成带偏移的 ISO 串解析。
  const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}+08:00`);
  return Number.isNaN(t) ? 0 : t;
}

// parseRetryAfter 从响应头解析上游明示等待时长（毫秒）；失败 0。
// 候选：retry-after（秒）→ retry-after-ms（毫秒）→ x-ratelimit-reset（epoch 秒/毫秒）。
const RETRY_AFTER_SANITY_MS = 2 * 3600_000;

export function parseRetryAfter(h: Headers): number {
  const ra = (h.get("retry-after") ?? "").trim();
  if (/^\d+$/.test(ra)) {
    const n = Number(ra) * 1000;
    if (n > 0 && n <= RETRY_AFTER_SANITY_MS) return n;
  }
  const rams = (h.get("retry-after-ms") ?? "").trim();
  if (/^\d+$/.test(rams)) {
    const n = Number(rams);
    if (n > 0 && n <= RETRY_AFTER_SANITY_MS) return n;
  }
  const reset = (h.get("x-ratelimit-reset") ?? "").trim();
  if (/^\d+$/.test(reset) && reset.length <= 16) {
    let n = Number(reset);
    if (reset.length >= 12) n = Math.floor(n / 1000); // 毫秒口径
    const remain = n * 1000 - Date.now();
    if (remain > 0 && remain <= RETRY_AFTER_SANITY_MS) return remain;
  }
  return 0;
}

// classify 按 HTTP 状态码 + body 判定错误类别（规则序与 Go Classify 一致）。
export function classify(status: number, body: string): ErrKind {
  // 0. 11102「该后端无此模型」最先判（只认 400/404）。
  if (isModelBlocked(status, body)) return "model_blocked";
  // 1. 402 真正的计费余额耗尽状态码。
  if (status === 402) return "hard_credit";
  const lower = body.toLowerCase();
  // 2. sessionDead 终态（精确词优先于限流宽泛子串）。
  for (const m of sessionDeadMarkers) {
    if (body.includes(m)) return "session_dead";
  }
  // 3. 账号级授权/配额故障（先于 status==429：14017 常带 429）。
  for (const m of accountFaultMarkers) {
    if (lower.includes(m.toLowerCase()) || body.includes(m)) return "account_fault";
  }
  // 4. 429 + code 14018 = 明确的账号积分耗尽。
  if (status === 429 && hasBusinessCode(body, "14018")) return "hard_credit";
  // 5. 429 状态码兜底 = 限流语义（先于 hardMarkers，防止限流被误判硬冷却）。
  if (status === 429) return "soft_rate";
  // 6. 非 429 携带计费关键词。
  for (const m of hardMarkers) {
    if (lower.includes(m.toLowerCase()) || body.includes(m)) return "hard_credit";
  }
  // 7. 非 429 携带限流文案。
  for (const m of softRateMarkers) {
    if (lower.includes(m.toLowerCase()) || body.includes(m)) return "soft_rate";
  }
  // 8. 11115 prompt too long（请求级语义先于状态码兜底）。
  if (isPromptTooLongStatus(status)) {
    for (const m of promptTooLongMarkers) {
      if (body.includes(m) || lower.includes(m.toLowerCase())) return "prompt_too_long";
    }
  }
  // 9. 404 / 5xx 常规分类。
  if (status === 404) return "not_found";
  if (status >= 500) return "server";
  // 10. WAF 403（无业务信封）。
  if (isWafBlocked(status, body)) return "waf_block";
  // 11. 图片无效（11135 / 文案）。
  if (status === 400 && codeMarker(lower, "11135")) return "image_invalid";
  if (status === 400) {
    for (const m of invalidImageMarkers) {
      if (lower.includes(m)) return "image_invalid";
    }
  }
  // 12. 内容策略 / 参数错误 / 其他 4xx。
  if (status >= 400) {
    for (const m of contentBlockedMarkers) {
      if (lower.includes(m)) return "content_blocked";
    }
    if (body.includes(badParamsMarkerMsg) || body.includes(badParamsMarkerCode)) {
      return "bad_params";
    }
    return "client";
  }
  return "none";
}

// isAlreadyCheckin 报告 err 是否表示「今天已签到」。调用方既有传 UpstreamError
// 的、也有传 e.message 字符串的（cron/单号签到路由），两种形态都接受。
export function isAlreadyCheckin(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (msg === "") return false;
  for (const m of alreadyCheckinMarkers) {
    if (msg.includes(m) || msg.toLowerCase().includes(m.toLowerCase())) {
      return true;
    }
  }
  return false;
}

// isSessionDead 报告 err 是否表示 session 失效（401+12153），对齐 Go ErrSessionDead 判定。
export function isSessionDead(err: unknown): boolean {
  return err instanceof UpstreamError && err.kind === "session_dead";
}

// ─── gateway_hint（移植 internal/upstream/hint.go） ────────────────────────
// error.message 永远是上游 body 原文透传；gateway_hint 只做与 message 并列的
// 网关视角补充说明，绝不替换/包装 message。未覆盖形态返回空串 → 调用方不带字段
//（不编造）。措辞英文（错误响应面向客户端工具链，英文是通用口径）。

export interface HintContext {
  model?: string; // 请求裸模型名（可空）
  hasImage?: boolean; // 请求体是否携带 image_url part
  modelSupportsImages?: boolean; // 目录 supports_images 声明（仅 inCatalog 时有意义）
  modelInCatalog?: boolean; // 目录是否收录该模型（「不支持」判定的前提）
}

// codeMarker JSON code 字段命中（`"code":N` 各空格/引号形态，与 isModelBlocked 同容差）。
function codeMarker(lower: string, code: string): boolean {
  const forms = [
    `"code":${code}`, `"code": ${code}`, `"code":"${code}"`,
    `"code": "${code}"`, `"code":" ${code}"`, `"code": '${code}'`,
  ];
  return forms.some((v) => lower.includes(v));
}

// isModelParamInvalid 上游 11133 body 判定（宁宽勿漏：hint 是补充说明非权威分类）。
function isModelParamInvalid(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    codeMarker(lower, "11133") ||
    lower.includes("model_param_invalid") ||
    lower.includes("invalid request parameters") ||
    lower.includes("request parameters do not meet the current model requirements")
  );
}

// isInvalidImageData 上游 11135 body 判定（invalid_image_data / "replace the image" 家族）。
function isInvalidImageData(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    codeMarker(lower, "11135") ||
    lower.includes("invalid_image_data") ||
    lower.includes("replace the image")
  );
}

// gatewayHint 按错误形态返回网关视角补充说明（error.gateway_hint 字段值）。
// 判定次序：11133/11135 上游业务码先于 Kind 表（两族归 client/bad_params 皆有可能，
// hint 层自带判定）；其余走 Kind 一对一映射。返回空串 = 未覆盖形态，不带字段。
export function gatewayHint(kind: ErrKind, msg: string, ctx: HintContext): string {
  // 11133 model_param_invalid 家族：只有请求确实带图、且目录能对该模型做出
  // 「不支持图片」的判定时才给「换模型」指向，否则退中性参数形态。
  if (isModelParamInvalid(msg)) {
    if (ctx.hasImage && ctx.modelInCatalog && !ctx.modelSupportsImages) {
      return "model " + (ctx.model ?? "") +
        " does not support images; pick one with supports_images=true from /v1/models";
    }
    return "request parameters were rejected by the model provider; check message format and model capabilities";
  }
  // 11135 invalid_image_data 家族。
  if (isInvalidImageData(msg)) {
    return "image data rejected by upstream; use a real/valid image, may need a new conversation";
  }
  switch (kind) {
    case "prompt_too_long":
      return "request context exceeds the model's limit; reduce history/message size";
    case "image_invalid":
      return "image request was rejected by upstream; check image_url format and image data";
    case "waf_block":
      // 账号级 WAF 403 与 IP 级 fail-fast 同 hint：对客户端动作一致（等窗口过去再试）。
      return "upstream WAF blocked the gateway; retry after the block window";
    case "soft_rate":
      return "rate limited by upstream; retry after reset";
    case "account_fault":
      return "account-level fault at upstream (auth/quota state); the gateway will rotate or disable this account";
    case "session_dead":
      return "account session expired at upstream; the account is disabled until re-login";
    case "hard_credit":
      return "account credits exhausted at upstream; waiting for daily check-in to restore";
    case "model_blocked":
      return "upstream has no such model on this backend; switch model or retry on another account";
    case "content_blocked":
      // 措辞不含 "upstream"：content_blocked 响应有不含上游字样的既有口径。
      return "request content was rejected by content policy; adjust the prompt and retry";
    default:
      // none/not_found/server/bad_params/client 等未覆盖形态：无 hint。
      return "";
  }
}

// NO_HEALTHY_HINT 本地调度类错误（无健康号可用，无上游原文可透传）的固定 hint。
const NO_HEALTHY_HINT = "no healthy account available in pool; check /status or retry later";
export const noHealthyAccountHint = (): string => NO_HEALTHY_HINT;

// frameKind 从 SSE error 帧 payload 判定 ErrKind：6004 模型级限流的流式形态优先；
// 其余取帧内 error.message 走 classify（请求级 400 口径）。判不出 → "none"（无 hint）。
export function frameKind(payload: string): ErrKind {
  if (isModelRateLimit(payload)) return "soft_rate";
  try {
    const f = JSON.parse(payload) as { error?: { message?: string } };
    const m = f?.error?.message;
    if (!m) return "none";
    return classify(400, m);
  } catch {
    return "none";
  }
}

// frameHint SSE error 帧的 gateway_hint（payload 原文 + 惰性求值的请求上下文）。
export function frameHint(payload: string, ctxFn: () => HintContext): string {
  if (payload === "" || payload === "[DONE]") return "";
  return gatewayHint(frameKind(payload), payload, ctxFn());
}
