// POST /api/v1/chat/completions —— OpenAI 兼容 chat 端点（网关主入口）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { identifyKeyIdentity } from "@/lib/auth-guard";
import { handleChat, openAIError } from "@/lib/chat";
import { isJSONObject, chatRequestError } from "@/lib/request-validation";
import { observeGateway } from "@/lib/workspace/gateway-observer";

function clientIP(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "";
}

export async function POST(req: Request): Promise<Response> {
  const identity = await identifyKeyIdentity(req);
  if (!identity) {
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
  const validationError = chatRequestError(body);
  if (validationError) return openAIError(400, "invalid_request", validationError);
  return observeGateway(req, body, "chat", identity, () => handleChat({
    body,
    clientIP: clientIP(req),
    inboundHeaders: req.headers,
    ua: req.headers.get("user-agent") ?? "",
    path: "/v1/chat/completions",
    req,
  }));
}
