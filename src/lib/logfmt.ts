// logfmt 统一日志的 uid 截断与账号标签（移植 Go internal/logfmt/logfmt.go）。
// 约定：
//   - uid 统一截 8 位：日志行只留 uid 前 8 位，全量 uid 在 DB/面板可查。
//   - Label 输出「昵称(uid8)」；昵称为空退回 uid8；两者皆空返回 "-"。
//   - 调度四类已有天然前缀（travel/activity/checkin/keepalive）保持不变。

import type { ErrKind } from "./upstream/errors";

// uid8 返回 uid 的前 8 位；空 uid 返回 "-"（对齐 Go UID8）。
export function uid8(uid: string): string {
  if (!uid) return "-";
  return uid.length > 8 ? uid.slice(0, 8) : uid;
}

// label 返回日志里的账号标签 "示例昵称甲(a1b2c3d4)"（对齐 Go Label）。
// 昵称认人、uid8 供 grep；uid 与 nick 同时为空返回 "-"。
export function label(uid: string, nick: string): string {
  const short = uid8(uid);
  const n = (nick ?? "").trim();
  return n === "" ? short : n + "(" + short + ")";
}

// ─── 报错内容（请求日志 errMsg / 运行日志 err= 片段） ─────────────────────
// 上游报错正文有两种形态：业务信封 JSON（信息密度高，原样保留）与网关整页 HTML
// （openresty/APISIX 的 401/403，标签占绝大部分体积）。落库与打屏前统一过一遍
// clipLogText：HTML 剥标签、空白压成单空格、超长截断——保证一行可 grep。

const reHtmlDoc = /<\s*(?:html|head|body|!doctype|center)\b/i;

// clipLogText 把上游响应正文压成单行日志片段（limit 为字符上限，含省略号）。
export function clipLogText(raw: string, limit = 1000): string {
  if (!raw) return "";
  let s = raw;
  if (reHtmlDoc.test(s)) {
    s = s
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ");
  }
  s = s.replace(/\s+/g, " ").trim();
  if (s.length <= limit) return s;
  return s.slice(0, Math.max(1, limit - 1)) + "…";
}

// accountReasonSummary 把冷却原因中的上游信封转成面板可读的一行摘要。
// 原始 reason 仍保留在 StatusRow.raw_reason，便于悬浮查看和定位上游问题；
// 不依赖完整 JSON，旧数据按 110 字符截断后也能提取业务码和重置文案。
export function accountReasonSummary(reason: string): string {
  if (!reason) return "";
  const soft = reason.startsWith("soft_rate:") || reason.startsWith("6004 ");
  if (!soft) return clipLogText(reason, 160);

  const code = /"code"\s*:\s*"?(\d+)"?/.exec(reason)?.[1] ?? "";
  const reset = /将在\s+(.+?)\s+重置/.exec(reason)?.[1]?.trim() ?? "";
  let label = "上游限流";
  if (code === "6000") label = "使用量已超出频率限制";
  else if (code === "14003") label = "上游请求过于频繁";
  else if (code === "6004" || reason.startsWith("6004 ")) label = "模型限流";

  const summary = label + (code ? `（${code}）` : "");
  return reset ? `${summary} · ${reset} 重置` : summary;
}

// accountReasonKind 给状态标签使用，避免把完整上游原因拼进标签。
export function accountReasonKind(reason: string): string {
  if (reason.startsWith("soft_rate:")) return "软限流";
  if (reason.startsWith("hard_credit:")) return "额度耗尽";
  if (reason.startsWith("account_fault:")) return "账号异常";
  if (reason.startsWith("waf_block:")) return "访问受限";
  if (reason === "breaker") return "熔断";
  if (reason === "consecutive failures") return "连续失败";
  return clipLogText(reason.split(":", 1)[0], 30);
}

// provider 直连链路（provider.ts / provider-observation.ts / chat.ts）自有的
// 错误码：不在 ErrKind 联合里，但与池内错误码一起落进 RequestLog.errKind。
type DirectErrKind =
  | "provider_not_authorized"
  | "provider_not_found"
  | "provider_error"
  | "invalid_model"
  | "model_not_allowed"
  | "invalid_request"
  | "transport"
  | "stream_interrupted"
  | "provider_http_error"
  | "provider_expected_sse"
  | "provider_stream_timeout"
  | "provider_stream_incomplete"
  | "provider_empty_stream"
  | "provider_stream_error"
  | "client_cancelled"
  | "provider_header_timeout"
  | "upstream_connect"
  | "upstream_timeout";

// 用穷举 Record 而不是普通对象：ErrKind 新增成员时编译失败，强制补中文标签，
// 避免面板再次把新机器码（或历史脏值 "unknown"）原样透出。
const ERR_KIND_LABELS: Record<ErrKind | DirectErrKind, string> = {
  none: "",
  hard_credit: "额度耗尽",
  soft_rate: "上游限流",
  soft_queue: "上游排队",
  session_dead: "会话失效",
  auth_expired: "凭证过期",
  account_fault: "账号异常",
  content_blocked: "内容拦截",
  model_blocked: "模型不可用",
  waf_block: "WAF 拦截",
  not_found: "上游 404",
  server: "上游 5xx",
  client: "请求错误",
  bad_params: "参数错误",
  image_invalid: "图片无效",
  prompt_too_long: "上下文超限",
  transport: "网络传输失败",
  stream_interrupted: "流中断",
  provider_not_authorized: "供应商未授权",
  provider_not_found: "供应商未注册",
  invalid_model: "模型无效",
  model_not_allowed: "模型未启用",
  invalid_request: "请求体无效",
  provider_http_error: "供应商 HTTP 错误",
  provider_expected_sse: "供应商未返回 SSE",
  provider_error: "供应商返回错误",
  provider_stream_timeout: "供应商流超时",
  provider_stream_incomplete: "供应商流不完整",
  provider_empty_stream: "供应商空流",
  provider_stream_error: "供应商流错误",
  client_cancelled: "客户端取消",
  provider_header_timeout: "供应商响应超时",
  upstream_connect: "供应商连接失败",
  // 池内账号侧等待上游首包超时（chat.ts finishLog 写入），与供应商流超时区分开。
  upstream_timeout: "上游超时",
};

// errKindLabel 把请求日志的 errKind 机器码转成面板可读的中文标签。
// 未知值（含历史脏数据 "unknown"）统一显示「未分类错误」，绝不把原始码
// 直接暴露给用户；空串返回空串，调用方据此决定是否追加标签。
export function errKindLabel(kind: string): string {
  const k = (kind ?? "").trim();
  if (!k) return "";
  return ERR_KIND_LABELS[k as keyof typeof ERR_KIND_LABELS] ?? "未分类错误";
}

// ─── 请求日志展示层占位值归一 ────────────────────────────────────────────
// 上游/客户端会把 "unknown"、"null"、"n/a" 之类当字段值直接报上来，原样渲染
// 会让请求日志表看起来像面板本身出错。这些值只做展示折叠，DB 里的原文不动。
const placeholderText = /^(?:unknown|undefined|null|n\/?a|nan)$/i;

// knownText 占位值返回空串（调用方渲染成 "—"），其余原样返回。
export function knownText(v: string | null | undefined): string {
  const s = (v ?? "").trim();
  return placeholderText.test(s) ? "" : s;
}

// uaDisplay 把 UA 里的 unknown 占位词换成中文；UA 其余部分（版本、平台）
// 保持原文——只影响展示，落库与筛选仍用原始 UA。
export function uaDisplay(ua: string | null | undefined): string {
  const s = (ua ?? "").trim();
  if (!s) return "";
  return s.replace(/\bunknown\b/gi, "未知");
}
