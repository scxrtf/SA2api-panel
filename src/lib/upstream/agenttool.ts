// agenttool 族上游调用（移植 internal/upstream/search.go，上游提交 657e7a4 / 3d5900f）：
//
//	POST {chatBase}/agenttool/v1/search   联网检索（snippet 级）
//	POST {chatBase}/agenttool/v1/webfetch 抓网页正文（markdown）
//
// 真实 codebuddy-lite-wb.mjs 的工具链路直接调用原生 fetch，不经过 chat 的
// Stainless SDK/axios RPC/uTLS；请求头与请求体独立构造。静态来源见
// .runtime/alignment-agenttool-evidence.json（不包含用户 token）。
// 回程原文透传；错误信封仍保留既有分类与 Retry-After 语义。
//
// 打包客户端的静态请求基线：type 固定小写 text2text；provider 不进入请求体；
// max_results 默认固定为 5。网关显式数量扩展不代表已验证上游最大结果数。
import type { AppConfig } from "../config";
import { classify, parseQueueRetryAfter, parseRetryAfter, UpstreamError } from "./errors";
import { chatBase, clientVersion, newMessageID, truncate, type AuthShape } from "./client";

const WEB_SEARCH_PATH = "/agenttool/v1/search";
const WEB_FETCH_PATH = "/agenttool/v1/webfetch";

// 官方自己的取值（上限不是保证）。
export const WEB_SEARCH_DEFAULT_MAX_RESULTS = 5;
export const WEB_SEARCH_TIMEOUT_MS = 20_000;
export const WEB_FETCH_DEFAULT_TIMEOUT_SECONDS = 20;
export const WEB_FETCH_DEFAULT_MAX_LENGTH = 100_000;
export const WEB_SEARCH_FRESHNESS = /^(?:d(?:[1-9]|[12]\d|30)?|m(?:[1-9]|1[0-2])?|y[1-5]?)$/;

export interface AgentToolContext {
  conversationID?: string;
  conversationRequestID?: string;
  agentIntent?: string;
  agentRuntime?: string;
  departmentInfo?: string;
}

export interface WebSearchOptions {
  allowed_domains?: string[];
  blocked_domains?: string[];
  freshness?: string;
  context?: AgentToolContext;
}

export interface WebFetchOptions {
  prompt?: string;
  timeout?: number; // 秒；官方默认 20，显式值为网关扩展。
  max_length?: number;
  model_name?: string;
  context?: AgentToolContext;
}

// 只接收工具本身使用的会话关联字段，不把入站 trace/baggage/SDK 头整批转发。
export function agentToolContext(headers: Headers): AgentToolContext {
  return {
    conversationID: headers.get("x-conversation-id") ?? "",
    conversationRequestID: headers.get("x-conversation-request-id") ?? "",
    agentIntent: headers.get("x-agent-intent") || undefined,
    agentRuntime: headers.get("x-agent-runtime") || undefined,
  };
}

export function agentToolHeaders(
  cfg: AppConfig, a: AuthShape, kind: "search" | "webfetch", context: AgentToolContext = {},
): Record<string, string> {
  const requestID = newMessageID(); // 真机 a7.nH 是 uuidv7，message/request 共用去横线值。
  const version = clientVersion(cfg, a);
  const ide = cfg.client_name || "WorkBuddy";
  const runtime = context.agentRuntime;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json;charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest",
    // bundle module57893 的 cq.Vo 明确为 CLI，而不是三段 WorkBuddy RPC UA。
    "User-Agent": cfg.user_agent || `CLI/${version}`,
    ...(a.accessToken ? { Authorization: "Bearer " + a.accessToken } : {}),
    "X-Agent-Intent": kind === "webfetch" ? "craft" : context.agentIntent || "craft",
    "X-Agent-Runtime": runtime
      ? ["local-agent", "cloud-agent", "agent-agent"].includes(runtime) ? runtime : "other"
      : "local-agent",
    "X-Conversation-ID": context.conversationID ?? "",
    "X-Conversation-Request-ID": context.conversationRequestID ?? "",
    "X-Conversation-Message-ID": requestID,
    "X-Request-ID": requestID,
    "X-Product": "SaaS",
    "X-IDE-Type": ide,
    "X-IDE-Name": ide,
    "X-IDE-Version": version,
    "X-User-Id": a.uid,
    ...(kind === "webfetch" ? { "X-Wb-Uid": a.uid } : {}),
    "X-Department-Info": context.departmentInfo ?? "",
  };
  return headers;
}

export function buildWebSearchBody(query: string, maxResults = 0, options: WebSearchOptions = {}) {
  const excluded = options.blocked_domains?.length
    ? ` (${options.blocked_domains.map((domain) => `-site:${domain}`).join(" ")})` : "";
  return {
    query: query + excluded,
    type: "text2text",
    // 默认严格为真机的 5；max_results/count 的显式正值保留既有兼容 API 语义。
    max_results: maxResults > 0 ? maxResults : WEB_SEARCH_DEFAULT_MAX_RESULTS,
    ...(options.allowed_domains?.length ? { allowed_domains: [...options.allowed_domains] } : {}),
    ...(options.freshness ? { freshness: options.freshness } : {}),
  };
}

export function buildWebFetchBody(url: string, options: WebFetchOptions = {}) {
  return {
    url,
    format: "markdown",
    // 原客户端工具要求 prompt；网关旧的仅 URL API 以空串兼容，而非静默丢弃字段。
    prompt: options.prompt ?? "",
    timeout: options.timeout ?? WEB_FETCH_DEFAULT_TIMEOUT_SECONDS,
    max_length: options.max_length ?? WEB_FETCH_DEFAULT_MAX_LENGTH,
    ...(options.model_name ? { model_name: options.model_name } : {}),
  };
}

// agentTool POST 到 agenttool 族端点；≥400 交 classify 定 Kind，供调用方走同一套
// 失败处置；200 但带非零 code（15003/15013 类）同样按错误抛出，不把错误当结果透传。
async function agentTool(
  cfg: AppConfig,
  a: AuthShape,
  path: string,
  body: unknown,
  signal?: AbortSignal,
  context?: AgentToolContext,
  timeoutMs = WEB_SEARCH_TIMEOUT_MS,
): Promise<string> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Request aborted", "AbortError");
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException("Agent tool request timed out", "TimeoutError")), timeoutMs);
  timer.unref?.();
  try {
    const resp = await fetch(chatBase(a) + path, {
      method: "POST",
      headers: agentToolHeaders(cfg, a, path === WEB_FETCH_PATH ? "webfetch" : "search", context),
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
    });
    // 网关也给读取正文保留同一超时保护，避免收到响应头后永久占用账号。
    const raw = await resp.text();
    if (resp.status >= 400) {
      let kind = classify(resp.status, raw);
      if (kind === "none") kind = "client";
      throw new UpstreamError(kind, resp.status, truncate(raw, 200),
        parseRetryAfter(resp.headers) || parseQueueRetryAfter(raw));
    }
    try {
      const env = JSON.parse(raw) as { code?: number; msg?: string };
      if (env && typeof env.code === "number" && env.code !== 0) {
        // 完整信封包含嵌套 code/retry_after；只传 msg 会漏掉 6020 和等待提示。
        let kind = classify(resp.status, raw);
        if (kind === "none") kind = "client";
        throw new UpstreamError(kind, resp.status,
          `code=${env.code} msg=${truncate(env.msg ?? "", 160)}`, parseQueueRetryAfter(raw));
      }
    } catch (e) {
      if (e instanceof UpstreamError) throw e;
      // 非 JSON：上游可能有别的形态，原文透传交给调用方判定。
    }
    return raw;
  } finally {
    clearTimeout(timer);
  }
}

// webSearch 联网检索，返回上游原文 JSON（含 results/total_results/provider）。
export async function webSearch(
  cfg: AppConfig,
  a: AuthShape,
  query: string,
  maxResults: number,
  signal?: AbortSignal,
  options: WebSearchOptions = {},
): Promise<string> {
  return agentTool(cfg, a, WEB_SEARCH_PATH, buildWebSearchBody(query, maxResults, options),
    signal, options.context);
}

// webFetch 抓取网页正文，返回上游原文 JSON（{url,title,content}，content 为 markdown）。
export async function webFetch(
  cfg: AppConfig, a: AuthShape, url: string, signal?: AbortSignal,
  options: WebFetchOptions = {},
): Promise<string> {
  const body = buildWebFetchBody(url, options);
  return agentTool(cfg, a, WEB_FETCH_PATH, body, signal, options.context, body.timeout * 1000);
}
