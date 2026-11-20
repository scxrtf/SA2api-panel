// POST /api/v1/search —— 官方 agenttool 联网检索的网关入口（移植 internal/server/search.go，
// 含上游 657e7a4「DeepSeek Search API 兼容」）。
//
// 请求：{query, allowed_domains?, blocked_domains?, freshness?, model?, realm?}。
// 官方默认固定 5 条；max_results/count 是保留的网关兼容扩展，显式正值原样传递。
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
import { agentToolContext, WEB_SEARCH_FRESHNESS, webSearch } from "@/lib/upstream/agenttool";
import { isJSONObject } from "@/lib/request-validation";

export async function POST(req: Request): Promise<Response> {
  if (!(await verifyAny(req))) {
    return openAIError(401, "invalid_api_key", "invalid or missing api key");
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!isJSONObject(parsed)) return openAIError(400, "invalid_request", "JSON body must be an object");
    body = parsed;
  } catch {
    return openAIError(400, "invalid_request", "invalid JSON body");
  }
  const query = typeof body["query"] === "string" ? body["query"] : "";
  if (!query.trim()) {
    return openAIError(400, "invalid_request", `query is required（例：{"query":"..."}）`);
  }
  if (query.length < 2) return openAIError(400, "invalid_request", "query must be at least 2 characters long");
  if (body["model"] !== undefined && (typeof body["model"] !== "string" || !body["model"].trim())) {
    return openAIError(400, "invalid_request", "model must be a non-empty string");
  }
  if (body["realm"] !== undefined && (typeof body["realm"] !== "string" || !["cn", "global"].includes(body["realm"].trim()))) {
    return openAIError(400, "invalid_request", "realm must be cn or global");
  }
  for (const name of ["max_results", "count"]) {
    const value = body[name];
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
      return openAIError(400, "invalid_request", `${name} must be a non-negative safe integer`);
    }
  }
  for (const name of ["allowed_domains", "blocked_domains"]) {
    const value = body[name];
    if (value !== undefined && (!Array.isArray(value) || value.some((domain) => typeof domain !== "string"))) {
      return openAIError(400, "invalid_request", `${name} must be an array of strings`);
    }
  }
  if (body["freshness"] !== undefined && (typeof body["freshness"] !== "string" || !WEB_SEARCH_FRESHNESS.test(body["freshness"]))) {
    return openAIError(400, "invalid_request", "freshness must be d/d1-d30, m/m1-m12, or y/y1-y5");
  }
  if (body["deep"] !== undefined && typeof body["deep"] !== "boolean") {
    return openAIError(400, "invalid_request", "deep must be a boolean");
  }
  if (body["deep"] === true) {
    // 综述式检索（agentic_search）本地未实现：不静默降级成 snippet 快路径，
    // 否则调用方会以为拿到了综述。
    return openAIError(400, "invalid_request", "deep=true (agentic search) 尚未支持");
  }
  const dshClient = deepSeekSearchClient(req.headers.get("user-agent") ?? "");
  const realm = resolveRealm(body["model"], body["realm"]);
  // 条数：优先 max_results 的正值，其次兼容 count；0/缺省都回落官方默认 5。
  let maxResults = typeof body["max_results"] === "number" ? (body["max_results"] as number) : 0;
  if (maxResults <= 0 && typeof body["count"] === "number") {
    maxResults = body["count"] as number;
  }
  const outcome = await runAgentTool(realm,
    (cfg, auth) => webSearch(cfg, auth, query, maxResults, req.signal, {
      allowed_domains: body["allowed_domains"] as string[] | undefined,
      blocked_domains: body["blocked_domains"] as string[] | undefined,
      freshness: body["freshness"] as string | undefined,
      context: agentToolContext(req.headers),
    }), req.signal);
  if (outcome.data === undefined) return agentToolError(outcome);
  const payload = dshClient ? compatDeepSeekSearch(outcome.data) : outcome.data;
  return new Response(payload, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
