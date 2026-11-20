// POST /api/v1/messages — Anthropic Messages API 兼容端点。
// 翻译 → 复用 handleChat 全管线（前缀路由/选号/重试/记账）→ 翻译回 Anthropic。
// 流式：聚合 OpenAI SSE 后重建 Anthropic 事件流（与 Go 同口径，不逐帧转写）。
import { identifyKeyIdentity } from "@/lib/auth-guard";
import { handleChat } from "@/lib/chat";
import { isJSONObject } from "@/lib/request-validation";
import { observeGateway } from "@/lib/workspace/gateway-observer";
import {
  anthropicError,
  anthropicErrorType,
  anthropicToOpenAI,
  hasAnthropicBeta,
  anthropicContextMgmtBeta,
  openaiToAnthropicMessage,
  aggregateOpenAISSE,
  buildAnthropicStream,
  AnthropicTranslateError,
  type AnthropicRequest,
} from "@/lib/anthropic";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  const identity = await identifyKeyIdentity(req);
  if (!identity) {
    return anthropicError(401, "authentication_error", "invalid api key");
  }
  let parsed: AnthropicRequest;
  try {
    const body: unknown = await req.json();
    if (!isJSONObject(body)) return anthropicError(400, "invalid_request_error", "JSON body must be an object");
    parsed = body as AnthropicRequest;
  } catch (e) {
    return anthropicError(
      400,
      "invalid_request_error",
      "parse body: " + (e instanceof Error ? e.message : String(e)),
    );
  }
  if (typeof parsed.model !== "string" || !parsed.model.trim()) {
    return anthropicError(400, "invalid_request_error", "model is required");
  }
  if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    return anthropicError(400, "invalid_request_error", "messages must be a non-empty array");
  }
  if (parsed.stream !== undefined && typeof parsed.stream !== "boolean") {
    return anthropicError(400, "invalid_request_error", "stream must be a boolean");
  }

  let openaiBody;
  try {
    openaiBody = anthropicToOpenAI(parsed);
  } catch (e) {
    const msg = e instanceof AnthropicTranslateError ? e.message : String(e);
    return anthropicError(400, "invalid_request_error", msg);
  }
  return observeGateway(req, parsed as unknown as Record<string, unknown>, "anthropic", identity,
    () => forwardAnthropic(req, parsed, openaiBody));
}

async function forwardAnthropic(req: Request, parsed: AnthropicRequest, openaiBody: ReturnType<typeof anthropicToOpenAI>) {
  const clientIP =
    (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() ?? "";
  const ua = req.headers.get("user-agent") ?? "";

  const resp = await handleChat({
    body: openaiBody,
    sessionBody: parsed as unknown as Record<string, unknown>,
    clientIP,
    inboundHeaders: req.headers,
    ua,
    path: "/v1/messages",
    req,
  });

  // 上游错误（非 2xx）：OpenAI 错误形态翻成 Anthropic 错误形态，message 透出。
  if (resp.status >= 400 || resp.status === 0) {
    const status = resp.status === 0 ? 502 : resp.status;
    const raw = await resp.text().catch(() => "");
    let msg = raw.trim();
    try {
      const oe = JSON.parse(raw) as { error?: { message?: string } };
      if (oe?.error?.message) msg = oe.error.message;
    } catch {
      // 非 JSON 错误体：原文透出。
    }
    if (!msg) msg = `upstream returned http ${status}`;
    return anthropicError(status, anthropicErrorType(status), msg);
  }

  const wantCtxMgmt = hasAnthropicBeta(req, anthropicContextMgmtBeta);

  if (parsed.stream !== true) {
    let body: Record<string, unknown>;
    try {
      body = (await resp.json()) as Record<string, unknown>;
    } catch (e) {
      return anthropicError(
        502,
        "api_error",
        "parse upstream response: " + (e instanceof Error ? e.message : String(e)),
      );
    }
    return Response.json(openaiToAnthropicMessage(body, wantCtxMgmt));
  }

  // 流式：聚合后重建 Anthropic 事件流。
  const text = await resp.text();
  const { frame, usage } = aggregateOpenAISSE(text);
  const sse = buildAnthropicStream(frame, usage, wantCtxMgmt);
  return new Response(sse, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
