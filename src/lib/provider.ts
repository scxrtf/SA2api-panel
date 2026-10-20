// 聚合供应商直连通道（internal/provider 简化移植）：命中生效供应商时完全旁路
// CodeBuddy 池管线（无粘性/无积分台账/无提示词改写），直接把 OpenAI 兼容请求
// 转发到供应商 baseUrl。
import { prisma } from "./db";
import { openAIError } from "./chat";
import { getConfig } from "./config";
import { idleMonitorBody } from "./upstream/idle";

// providerChat 通用 OpenAI 直连：body 中模型名重写为 bare 后原样转发。
export async function providerChat(
  name: string,
  bareModel: string,
  body: string,
  stream: boolean,
): Promise<Response> {
  const p = await prisma.provider.findUnique({ where: { name } });
  if (!p) return openAIError(400, "provider_not_found", `provider ${name} not registered`);
  let out = body;
  try {
    const obj = JSON.parse(body) as Record<string, unknown>;
    obj["model"] = bareModel;
    if (stream) obj["stream"] = true;
    out = JSON.stringify(obj);
  } catch {
    // 解析失败按原文转发。
  }
  const base = p.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (p.apiKey) headers["Authorization"] = "Bearer " + p.apiKey;
  let resp: globalThis.Response;
  try {
    resp = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers,
      body: out,
    });
  } catch (e) {
    return openAIError(
      502, "upstream_connect",
      e instanceof Error ? e.message : "provider connect failed",
    );
  }
  if (stream && resp.ok && resp.body) {
    // 空闲看门狗（对齐 Go provider.go:381 MonitorBodyFor）：默认 300s，
    // 配置了 stream_idle_ms>0 时以配置为准；0 表示沿用默认而非禁用（与 Go 一致）。
    const cfgIdle = (await getConfig()).stream_idle_ms;
    const idle = cfgIdle > 0 ? cfgIdle : 300_000;
    return new Response(idleMonitorBody(resp.body, idle), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  }
  const raw = await resp.text();
  return new Response(raw, {
    status: resp.status,
    headers: { "Content-Type": resp.headers.get("content-type") ?? "application/json" },
  });
}

// providerModels 聚合各供应商的 /v1/models 目录（面板/对外 /v1/models 用）。
export async function providerModels(): Promise<{ id: string; owned_by: string }[]> {
  const providers = await prisma.provider.findMany();
  const out: { id: string; owned_by: string }[] = [];
  for (const p of providers) {
    try {
      const base = p.baseUrl.replace(/\/+$/, "");
      const headers: Record<string, string> = {};
      if (p.apiKey) headers["Authorization"] = "Bearer " + p.apiKey;
      const resp = await fetch(base + "/v1/models", {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) continue;
      const data = (await resp.json()) as { data?: { id?: string }[] };
      for (const m of data.data ?? []) {
        if (!m.id) continue;
        // 白名单（逗号分隔）非空时只暴露勾选模型；空 = 全部。
        const allow = p.models ? p.models.split(",").map((s) => s.trim()).filter(Boolean) : null;
        if (allow && !allow.includes(m.id)) continue;
        out.push({ id: `${p.name}:${m.id}`, owned_by: p.name });
      }
    } catch {
      // 单供应商失败不影响其他。
    }
  }
  return out;
}
