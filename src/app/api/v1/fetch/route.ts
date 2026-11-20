// POST /api/v1/fetch —— DeepSeek Fetch API 兼容入口（移植 internal/server/fetch.go，
// 上游 3d5900f）：DSH 的 web-deepseek-api 把 /search 与 /fetch 指向同一 baseURL。
//
// 请求 {url,prompt?,model_name?,timeout?,max_length?,model?,realm?}；官方默认
// format=markdown、timeout=20秒、max_length=100000，URL-only 调用兼容 prompt=""。
// 响应 {content:<markdown>, url, title}（上游字段透传；
// content 缺失/非字符串按 502 报错，不伪造空正文——空正文会被 DSH 当成「页面没有
// 可用内容」的成功抓取，掩盖真实故障）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { verifyAny } from "@/lib/auth-guard";
import { openAIError } from "@/lib/chat";
import { agentToolError, resolveRealm, runAgentTool } from "@/lib/agenttool-route";
import { agentToolContext, webFetch } from "@/lib/upstream/agenttool";
import { isJSONObject } from "@/lib/request-validation";

// normalizeFetchResponse 确保响应是 DSH 需要的 {"content": "<markdown>"} 形状。
function normalizeFetchResponse(raw: string, reqURL: string): { out?: string; err?: string } {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { err: "upstream fetch response is not a JSON object" };
  }
  if (!obj || typeof obj !== "object") {
    return { err: "upstream fetch response is not a JSON object" };
  }
  const content = obj["content"];
  if (content === undefined || content === null) {
    return { err: "upstream fetch response has no content field" };
  }
  if (typeof content !== "string") {
    return { err: "upstream fetch content is not a string" };
  }
  // url 缺失时补请求 URL（DSH 不消费该字段，但上游语义上应回显）。
  if (!("url" in obj)) obj["url"] = reqURL;
  return { out: JSON.stringify(obj) };
}

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
  const target = typeof body["url"] === "string" ? (body["url"] as string).trim() : "";
  if (!target) {
    return openAIError(400, "invalid_request", `url is required（例：{"url":"https://example.com"})`);
  }
  // 只接受 http/https：上游 webfetch 对其它 scheme 只会回 400，本地先拦住。
  let scheme = "";
  try {
    scheme = new URL(target).protocol;
  } catch {
    scheme = "";
  }
  if (scheme !== "http:" && scheme !== "https:") {
    return openAIError(400, "invalid_request", "url must be an absolute http(s) URL");
  }
  for (const name of ["prompt", "model", "model_name"]) {
    const value = body[name];
    if (value !== undefined && (typeof value !== "string" || name !== "prompt" && !value.trim())) {
      return openAIError(400, "invalid_request", `${name} must be ${name === "prompt" ? "a string" : "a non-empty string"}`);
    }
  }
  if (body["realm"] !== undefined && (typeof body["realm"] !== "string" || !["cn", "global"].includes(body["realm"].trim()))) {
    return openAIError(400, "invalid_request", "realm must be cn or global");
  }
  if (body["format"] !== undefined && body["format"] !== "markdown") {
    return openAIError(400, "invalid_request", "format must be markdown");
  }
  // 可选范围是网关保护值，不宣称是上游公开接口限制；显式值不静默丢弃。
  for (const [name, max] of [["timeout", 120], ["max_length", 1_000_000]] as const) {
    const value = body[name];
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max)) {
      return openAIError(400, "invalid_request", `${name} must be an integer from 1 to ${max}`);
    }
  }
  const realm = resolveRealm(body["model"], body["realm"]);
  const selectedModel = typeof body["model"] === "string"
    ? body["model"].trim().replace(/^(?:cn|global):/i, "") : "";
  const outcome = await runAgentTool(realm,
    (cfg, auth) => webFetch(cfg, auth, target, req.signal, {
      prompt: body["prompt"] as string | undefined,
      model_name: (body["model_name"] as string | undefined) || selectedModel || undefined,
      timeout: body["timeout"] as number | undefined,
      max_length: body["max_length"] as number | undefined,
      context: agentToolContext(req.headers),
    }), req.signal);
  if (outcome.data === undefined) return agentToolError(outcome);
  const norm = normalizeFetchResponse(outcome.data, target);
  if (norm.err) {
    // 上游 200 但形状不对：改写成 502，别把半成品当成功透传。
    return openAIError(502, "upstream_error", norm.err);
  }
  return new Response(norm.out, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
