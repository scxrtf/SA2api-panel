// 聚合供应商直连通道（internal/provider 简化移植）：命中生效供应商时完全旁路
// CodeBuddy 池管线（无粘性/无积分台账/无提示词改写），直接把 OpenAI 兼容请求
// 转发到供应商 baseUrl。
import { prisma } from "./db";
import { openAIError } from "./chat";
import { getConfig } from "./config";
import { idleMonitorBody } from "./upstream/idle";
import { usageTokensFromResponse } from "./upstream/usage";

// recordProviderUsage 供应商记账（Go handler.go recordProviderAttempt 同语义）：
// realm 记为 "provider:"+名字，uid 记为槽位名。这里 TS 版单 key 直连无槽位
// 轮换，uid 用 provider 名（聚合视图按 realm 前缀取供应商名，uid 仅备查）。
async function recordProviderUsage(
  name: string,
  slot: string,
  model: string,
  keyName: string,
  ok: boolean,
  pt: number,
  ct: number,
  tt: number,
  latencyMs: number,
): Promise<void> {
  try {
    await prisma.usageEvent.create({
      data: {
        uid: slot || name,
        model,
        realm: "provider:" + name,
        provider: name,
        promptTokens: pt,
        completionTok: ct,
        totalTokens: tt,
        latencyMs,
        keyName,
        ok,
        errKind: ok ? "" : "provider_error",
      },
    });
  } catch {
    // 记账失败不阻断主链路。
  }
}

// providerChat 通用 OpenAI 直连：body 中模型名重写为 bare 后原样转发。
export async function providerChat(
  name: string,
  bareModel: string,
  body: string,
  stream: boolean,
  keyName = "",
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
  const attemptStarted = Date.now();
  try {
    resp = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers,
      body: out,
    });
  } catch (e) {
    void recordProviderUsage(name, name, bareModel, keyName, false, 0, 0, 0, Math.max(1, Date.now() - attemptStarted));
    return openAIError(
      502, "upstream_connect",
      e instanceof Error ? e.message : "provider connect failed",
    );
  }
  const latencyMs = Math.max(1, Date.now() - attemptStarted);
  if (stream && resp.ok && resp.body) {
    // 空闲看门狗（对齐 Go provider.go:381 MonitorBodyFor）：默认 300s，
    // 配置了 stream_idle_ms>0 时以配置为准；0 表示沿用默认而非禁用（与 Go 一致）。
    const cfgIdle = (await getConfig()).stream_idle_ms;
    const idle = cfgIdle > 0 ? cfgIdle : 300_000;
    // 旁路统计（Go chatStatsReader 同语义）：tee 一路只读末帧 usage 的
    // prompt/completion/total，主路原样透传（供应商帧不经 normalizeFrame）。
    const [main, side] = resp.body.tee();
    void (async () => {
      let pt = 0, ct = 0, tt = 0;
      try {
        const reader = side.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith("data: ") || line.startsWith("data: [DONE]")) continue;
            try {
              const obj = JSON.parse(line.slice(6)) as Record<string, unknown>;
              if (obj["usage"] && typeof obj["usage"] === "object") {
                ({ pt, ct, tt } = usageTokensFromResponse(obj));
              }
            } catch {
              // 非 JSON 帧跳过。
            }
          }
        }
      } catch {
        // 旁路读取失败不影响主路。
      }
      recordProviderUsage(name, name, bareModel, keyName, true, pt, ct, tt, latencyMs).catch(() => undefined);
    })();
    return new Response(idleMonitorBody(main, idle), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  }
  const raw = await resp.text();
  // 供应商响应 token 观测（Go usageTokensFromResponse）：成功时从 usage 原对象
  // 提取；错误响应 usage 通常缺省，记 0。
  let pt = 0, ct = 0, tt = 0;
  if (resp.ok) {
    try {
      ({ pt, ct, tt } = usageTokensFromResponse(JSON.parse(raw) as Record<string, unknown>));
    } catch {
      // 非 JSON 体：无 usage 观测。
    }
  }
  void recordProviderUsage(name, name, bareModel, keyName, resp.ok, pt, ct, tt, latencyMs);
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
