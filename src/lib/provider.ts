// 供应商直连绕过池选号、粘性、提示词改写；日志在响应真正结束后落库。
import { prisma } from "./db";
import type { Prisma } from "@prisma/client";
import { openAIError } from "./chat";
import { getConfig } from "./config";
import { idleMonitorBody } from "./upstream/idle";
import { maybeProbeAfterModelCall } from "./model-health-trigger";
import { providerEndpoint } from "./provider-endpoint";
import { ProviderObservation, observeProviderStream } from "./provider-observation";
import { markRunlogPersisted, runlog } from "./runlog"; import { clipLogText } from "./logfmt"; import { failureDetail, parameterOverrides, type AttemptDetail } from "./request-log-detail";

// 供应商表进程内快照。原先每次 providerChat 都 findUnique 一次、每次
// providerModels / modelhealth 目录刷新都 findMany 一次，是 egress 的固定开销。
// 60s TTL + 面板写路径显式失效（见 api/panel/providers 路由）。
const PROVIDERS_TTL_MS = 60_000;
export type ProviderRow = {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string;
};
type ProvidersCache = { at: number; rows: ProviderRow[] };
const providerGlobals = globalThis as unknown as { __wbProviders?: ProvidersCache };

export function invalidateProviders(): void {
  delete providerGlobals.__wbProviders;
}

export async function loadProviders(): Promise<ProviderRow[]> {
  const cached = providerGlobals.__wbProviders;
  if (cached && Date.now() - cached.at < PROVIDERS_TTL_MS) return cached.rows.slice();
  const rows = await prisma.provider.findMany({
    select: { name: true, baseUrl: true, apiKey: true, models: true },
  });
  providerGlobals.__wbProviders = { at: Date.now(), rows };
  return rows.slice();
}

export async function findProvider(name: string): Promise<ProviderRow | null> {
  const rows = await loadProviders();
  return rows.find((r) => r.name === name) ?? null;
}

interface ProviderRequestContext {
  started: number;
  clientIP: string;
  ua: string;
  path: string;
  signal?: AbortSignal;
}

export async function providerChat(
  name: string,
  bareModel: string,
  body: string,
  stream: boolean,
  keyName = "",
  requestedModel = "",
  context?: ProviderRequestContext,
): Promise<Response> {
  const started = context?.started ?? Date.now();
  const logModel = requestedModel || `${name}:${bareModel}`;
  const stats = new ProviderObservation(started);
  let outboundOverrides: ReturnType<typeof parameterOverrides> = [];
  let attempts = 0;
  let recorded = false;
  // errMsg 为失败请求的报错内容（供应商回包正文，已 clip）；成功路径留空。
  let failureCode = "";
  let failureMessage = "";
  let failureUpstream = "";
  let failureStage = "";
  const finish = async (status: number, errMsg = ""): Promise<void> => {
    if (recorded) return;
    recorded = true;
    const errText = errMsg ? clipLogText(errMsg, 1000) : "";
    const durationMs = Math.max(1, Date.now() - started);
    const ok = status < 400 && !stats.errKind;
    const code = failureCode || stats.errKind || (ok ? "" : "provider_error");
    const detail = ok ? "" : failureDetail({
      status,
      code,
      kind: stats.errKind,
      message: failureMessage,
      upstream: failureUpstream || stats.errorBody,
      stage: failureStage,
    });
    const attemptDetails: AttemptDetail[] = attempts > 0 ? [{
      attempt: 1,
      provider: name,
      status,
      ok,
      errKind: stats.errKind,
      durationMs,
      ttfbMs: stream ? stats.ttfbMs : 0,
      error: detail,
    }] : [];
    const common = {
      model: logModel, realm: "provider:" + name, provider: name, keyName,
      promptTokens: stats.promptTokens, completionTok: stats.completionTok,
      totalTokens: stats.totalTokens, cacheHitTok: stats.cacheHitTok,
      cacheMissTok: stats.cacheMissTok, errKind: stats.errKind,
    };
    const logRef = runlog(       `[call] ${logModel} ${ok ? "成功" : "失败"} HTTP ${status} ` +       `provider=${name} ${durationMs}ms` +       (errText ? " err=" + clipLogText(errText, 180) : ""),     );
    // 单 key 供应商用名字标识槽位；不伪造池 UID/机器码/积分。
    // 两表独立写入：一表失败不能阻止另一表；只记录错误码，不泄露凭据。
    const requestLogTask = Promise.resolve().then(() => prisma.requestLog.create({ data: {
      ...common, uid: "", slot: attempts ? name : "", machineId: "",
      errMsg: errText,
      status, stream, durationMs, attempts, ttfbMs: stream ? stats.ttfbMs : 0,
      clientIp: context?.clientIP ?? "", ua: context?.ua ?? "",
      path: context?.path ?? "/v1/chat/completions",
      errorDetail: detail,
      parameterOverrides: outboundOverrides.length
        ? outboundOverrides as unknown as Prisma.InputJsonValue : undefined,
      attemptDetails: attemptDetails.length
        ? attemptDetails as unknown as Prisma.InputJsonValue : undefined,
    } }));
    const tasks: Promise<unknown>[] = [requestLogTask];
    if (attempts) tasks.push(Promise.resolve().then(() => prisma.usageEvent.create({ data: {
      ...common, uid: name, ok, latencyMs: durationMs,
    } })));
    const results = await Promise.allSettled(tasks);
    if (results[0]?.status === "fulfilled") {
      const created = results[0].value as { id?: string };
      if (created.id) markRunlogPersisted(logRef, created.id);
    }
    for (const result of results) {
      if (result.status === "rejected") {
        const code = typeof result.reason?.code === "string"
          ? result.reason.code
          : result.reason instanceof Error ? result.reason.name : "write_failed";
        runlog(`WARN: provider audit write failed (${code}); check database migrations`);
      }
    }
    if (results[0]?.status === "fulfilled") {
      void maybeProbeAfterModelCall({
        realm: "provider:" + name,
        provider: name,
        bare: bareModel,
      });
    }
  };
  const fail = async (
    status: number,
    kind: string,
    message: string,
    upstream = "",
    stage = "",
  ): Promise<Response> => {
    stats.errKind = kind;
    failureCode = kind;     failureMessage = message;     failureUpstream = upstream;     failureStage = stage;     await finish(status, upstream || message);
    return openAIError(status, kind, message);
  };

  const p = await findProvider(name);
  if (!p) {
    return fail(400, "provider_not_found", `provider ${name} not registered`, "", "provider_lookup");
  }
  if (!bareModel) return fail(400, "invalid_model", "provider model is required", "", "model_validation");
  const allow = p.models.split(",").map((m) => m.trim()).filter(Boolean);
  if (allow.length && !allow.includes(bareModel)) {
    return fail(
      400,
      "model_not_allowed",
      `model is not enabled for provider ${name}`,
      "",
      "model_validation",
    );
  }
  let source: Record<string, unknown>;
  let out: string;
  try {
    source = JSON.parse(body) as Record<string, unknown>;
    const obj = { ...source };
    obj.model = bareModel;
    obj.stream = stream;
    out = JSON.stringify(obj);
    outboundOverrides = parameterOverrides(source, obj);
  } catch {
    return fail(400, "invalid_request", "invalid JSON body", "", "request_parse");
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (p.apiKey) headers.Authorization = "Bearer " + p.apiKey;
  let resp: Response;
  const cfg = await getConfig();
  const controller = new AbortController();
  // 响应头超时不限制长时间正常输出；客户端取消在整个响应生命周期生效。
  const timeout = setTimeout(() => controller.abort(), Math.max(1, cfg.header_timeout_ms || 30_000));
  const signal = context?.signal
    ? AbortSignal.any([controller.signal, context.signal]) : controller.signal;
  attempts = 1;
  try {
    resp = await fetch(providerEndpoint(p.baseUrl, "/chat/completions"), {
      method: "POST", headers, body: out, signal,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.stack || e.message : String(e);
    if (context?.signal?.aborted) {
      return fail(499, "client_cancelled", "client cancelled request", detail, "provider_connect");
    }
    if (controller.signal.aborted) {
      return fail(
        504,
        "provider_header_timeout",
        "provider response headers timed out",
        detail,
        "provider_connect",
      );
    }
    return fail(502, "upstream_connect", e instanceof Error ? e.message : "provider connect failed",
      detail, "provider_connect");
  } finally {
    clearTimeout(timeout);
  }
  const contentType = resp.headers.get("content-type") ?? "application/json";
  if (stream && resp.ok && resp.body && /text\/event-stream/i.test(contentType)) {
    const cfgIdle = cfg.stream_idle_ms;
    const monitored = idleMonitorBody(resp.body, cfgIdle > 0 ? cfgIdle : 300_000,
      () => {
        stats.errKind ||= "provider_stream_timeout";
        stats.errorBody ||= "provider stream idle timeout";
      });
    return new Response(observeProviderStream(monitored, stats, () => finish(resp.status)), {
      status: resp.status,
      headers: { "Content-Type": contentType, "Cache-Control": "no-cache" },
    });
  }
  // stream=true 也可能收到 JSON 错误信封；按实际 Content-Type 观测并透传。
  let raw: string;
  try { raw = await resp.text(); }
  catch (e) {
    return fail(502, "provider_read_error", "provider response body read failed",
      e instanceof Error ? e.stack || e.message : String(e), "provider_read");
  }
  stats.rawBody = raw;
  if (!resp.ok) {
    stats.errKind = "provider_http_error";
    stats.errorBody = raw;
    failureMessage = `provider returned HTTP ${resp.status}`;
    failureStage = "provider_response";
  }
  try { stats.json(JSON.parse(raw)); } catch { /* 保留非 JSON 响应。 */ }
  if (stream && resp.ok && !stats.errKind) stats.errKind = "provider_expected_sse";
  await finish(resp.status, resp.ok ? "" : raw);
  return new Response([204, 205, 304].includes(resp.status) ? null : raw, {
    status: resp.status,
    headers: { "Content-Type": contentType },
  });
}
// providerModels 聚合各供应商的 /v1/models 目录（面板/对外 /v1/models 用）。
// allowed 为 null/undefined 时不限制；传入集合时只探测集合内的供应商。
export async function providerModels(
  allowed?: ReadonlySet<string> | null,
  errors?: string[],
): Promise<{ id: string; owned_by: string }[]> {
  const providers = await loadProviders();
  const out: { id: string; owned_by: string }[] = [];
  for (const p of providers) {
    if (allowed && !allowed.has(p.name)) continue;
    try {
      const headers: Record<string, string> = {};
      if (p.apiKey) headers["Authorization"] = "Bearer " + p.apiKey;
      const resp = await fetch(providerEndpoint(p.baseUrl, "/models"), {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        errors?.push(p.name + ": http " + resp.status);
        continue;
      }
      const data = (await resp.json()) as { data?: { id?: string }[] };
      for (const m of data.data ?? []) {
        if (!m.id) continue;
        // 白名单（逗号分隔）非空时只暴露勾选模型；空 = 全部。
        const allow = p.models ? p.models.split(",").map((s) => s.trim()).filter(Boolean) : null;
        if (allow && !allow.includes(m.id)) continue;
        out.push({ id: `${p.name}:${m.id}`, owned_by: p.name });
      }
    } catch (e) {
      // 单供应商失败不影响其他。
      errors?.push(p.name + ": " + (e instanceof Error ? e.message : String(e)));
    }
  }
  return out;
}
