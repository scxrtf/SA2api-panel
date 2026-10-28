// agenttool 族上游调用（移植 internal/upstream/search.go，上游提交 657e7a4 / 3d5900f）：
//
//	POST {chatBase}/agenttool/v1/search   联网检索（snippet 级）
//	POST {chatBase}/agenttool/v1/webfetch 抓网页正文（markdown）
//
// 鉴权与 chat 同源：Bearer + 会话三件套（chatHeaders 零值 meta 兜底恒发）。回程
// **原文透传**——该族响应没有 {code,msg,data} 信封，故不走 doJSON。
//
// 请求字段实测边界：
//   - type 只有小写 text2text 合法，省略时服务端自动回填；
//   - provider 是响应字段，请求里带上任何值都 400 {code:15003}；
//   - max_results 是上限不是保证（服务端硬上限约 10），官方固定用 5。
import type { AppConfig } from "../config";
import { classify, parseQueueRetryAfter, parseRetryAfter, UpstreamError } from "./errors";
import { chatBase, chatHeaders, truncate, type AuthShape } from "./client";

const WEB_SEARCH_PATH = "/agenttool/v1/search";
const WEB_FETCH_PATH = "/agenttool/v1/webfetch";

// 官方自己的取值（上限不是保证）。
export const WEB_SEARCH_DEFAULT_MAX_RESULTS = 5;

// agentTool POST 到 agenttool 族端点；≥400 交 classify 定 Kind，供调用方走同一套
// 失败处置；200 但带非零 code（15003/15013 类）同样按错误抛出，不把错误当结果透传。
async function agentTool(
  cfg: AppConfig,
  a: AuthShape,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const h = chatHeaders(cfg, a, "", {
    conversationID: "",
    cacheKeyID: "",
    conversationRequestID: "",
    traceID: "",
  });
  h["Content-Type"] = "application/json";
  const resp = await fetch(chatBase(a) + path, {
    method: "POST",
    headers: h,
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
    cache: "no-store",
  });
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
}

// webSearch 联网检索，返回上游原文 JSON（含 results/total_results/provider）。
export async function webSearch(
  cfg: AppConfig,
  a: AuthShape,
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<string> {
  const n = maxResults > 0 ? maxResults : WEB_SEARCH_DEFAULT_MAX_RESULTS;
  return agentTool(cfg, a, WEB_SEARCH_PATH, {
    query,
    type: "text2text",
    max_results: n,
  }, signal);
}

// webFetch 抓取网页正文，返回上游原文 JSON（{url,title,content}，content 为 markdown）。
export async function webFetch(
  cfg: AppConfig, a: AuthShape, url: string, signal?: AbortSignal,
): Promise<string> {
  return agentTool(cfg, a, WEB_FETCH_PATH, { url }, signal);
}
