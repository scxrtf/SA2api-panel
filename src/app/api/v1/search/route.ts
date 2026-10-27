// POST /api/v1/search —— 官方 agenttool 联网检索的网关入口（移植 internal/server/search.go，
// 含上游 657e7a4「DeepSeek Search API 兼容」）。
//
// 请求：{query, max_results, model?, realm?}；DSH（UA 含 deepseek-harness）额外接受 count。
// 响应：上游原文逐字节透传；仅 DSH 补 date:null 与 title/snippet 空串（DeepSeek
// Search API 对字段类型校验很硬：date 缺失即 invalidResponse）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { verifyAny } from "@/lib/auth-guard";
import { openAIError } from "@/lib/chat";
import {
  agentToolError,
  compatDeepSeekSearch,
  deepSeekSearchClient,
  resolveRealm,
  runAgentTool,
} from "@/lib/agenttool-route";
import { webSearch } from "@/lib/upstream/agenttool";

export async function POST(req: Request): Promise<Response> {
  if (!(await verifyAny(req))) {
    return openAIError(401, "invalid_api_key", "invalid or missing api key");
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return openAIError(400, "invalid_request", "invalid JSON body");
  }
  const query = typeof body["query"] === "string" ? (body["query"] as string).trim() : "";
  if (!query) {
    return openAIError(400, "invalid_request", `query is required（例：{"query":"..."}）`);
  }
  if (body["deep"] === true) {
    // 综述式检索（agentic_search）本地未实现：不静默降级成 snippet 快路径，
    // 否则调用方会以为拿到了综述。
    return openAIError(400, "invalid_request", "deep=true (agentic search) 尚未支持");
  }
  const dshClient = deepSeekSearchClient(req.headers.get("user-agent") ?? "");
  const realm = resolveRealm(body["model"], body["realm"]);
  // 条数：优先 max_results；DSH 的 deepseek-search-api 只发 count，回落它
  //（0 由上游取默认 5）。
  let maxResults = typeof body["max_results"] === "number" ? (body["max_results"] as number) : 0;
  if (dshClient && maxResults <= 0 && typeof body["count"] === "number") {
    maxResults = body["count"] as number;
  }
  const outcome = await runAgentTool(realm, (cfg, auth) => webSearch(cfg, auth, query, maxResults));
  if (outcome.data === undefined) return agentToolError(outcome);
  const payload = dshClient ? compatDeepSeekSearch(outcome.data) : outcome.data;
  return new Response(payload, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
