// 模型健康探测：对目录中的每个模型发送一次最小真实聊天请求，并把每次结果落库。
// 与 modelscan（限流扫描）和 ModelProbe（最大输出探测）不同，这里只回答
// “本次请求是否成功拿到有效响应帧”，供面板计算真实可用率与心跳历史。
import { randomUUID } from "crypto";
import { prisma } from "./db";
import { getConfig, type AppConfig } from "./config";
import { authShapeOf } from "./login";
import { providerModels } from "./provider";
import { providerEndpoint } from "./provider-endpoint";
import { runlog } from "./runlog";
import { chatStream } from "./upstream/client";
import { classify, isModelRateLimit, isQueueWait } from "./upstream/errors";
import { fetchGlobalModelInfos, fetchModelsFull } from "./upstream/modelCatalog";

const PROBE_TIMEOUT_MS = 30_000;
const FRAME_WAIT_MS = 12_000;
const FINAL_USAGE_WAIT_MS = 1_000;
const PROBE_CONCURRENCY = 4;
const HEALTH_RETENTION_MS = 30 * 24 * 3600_000;
const API_HISTORY_MS = 24 * 3600_000;
const API_HISTORY_LIMIT = 65;

type ProbeKind = string;
type AuthShape = ReturnType<typeof authShapeOf>;

interface PoolTarget {
  channel: "pool";
  key: string;
  model: string;
  shape: AuthShape;
}

interface ProviderTarget {
  channel: "provider";
  key: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

type HealthTarget = PoolTarget | ProviderTarget;

interface ProbeOutcome {
  ok: boolean;
  status: number;
  errorKind: ProbeKind;
  detail: string;
  latencyMs: number;
  completionTokens: number;
  tokensPerSecond: number;
}

export interface ModelHealthRunResult {
  total: number;
  ok: number;
  failed: number;
  catalogErrors: number;
  durationMs: number;
}

export interface ModelHealthRecordView {
  ok: boolean;
  status: number;
  latency_ms: number;
  completion_tokens: number;
  tokens_per_second: number;
  error_kind: string;
  detail: string;
  checked_at: string;
}

interface HealthState {
  running: Promise<ModelHealthRunResult> | null;
  focused: Map<string, Promise<ModelHealthRunResult>>;
}

const g = globalThis as unknown as { __wbModelHealth?: HealthState };
const state: HealthState = g.__wbModelHealth ?? (g.__wbModelHealth = {
  running: null,
  focused: new Map(),
});
if (!state.focused) state.focused = new Map();

// runModelHealthProbe 执行一轮全模型健康探测；手动触发可只探测一个模型。
// 同一模型进程内单飞；单项探测会排在正在运行的全量探测之后，避免被全量结果吞掉。
export function runModelHealthProbe(source = "scheduler", modelKey = ""): Promise<ModelHealthRunResult> {
  const selected = modelKey.trim();
  if (selected) {
    const active = state.focused.get(selected);
    if (active) return active;
    const running = (async () => {
      if (state.running) await state.running.catch(() => undefined);
      return executeProbe(source, selected);
    })();
    state.focused.set(selected, running);
    const clear = () => {
      if (state.focused.get(selected) === running) state.focused.delete(selected);
    };
    void running.then(clear, clear);
    return running;
  }

  if (state.running) return state.running;
  const running = (async () => {
    if (state.focused.size > 0) {
      await Promise.allSettled([...state.focused.values()]);
    }
    return executeProbe(source, "");
  })();
  state.running = running;
  const clear = () => {
    if (state.running === running) state.running = null;
  };
  void running.then(clear, clear);
  return running;
}

export async function latestModelHealthAt(): Promise<Date | null> {
  const row = await prisma.modelHealthCheck.findFirst({
    orderBy: { checkedAt: "desc" },
    select: { checkedAt: true },
  });
  return row?.checkedAt ?? null;
}

// listModelHealth 返回近 24 小时、每个模型最近 65 次检查（旧到新）。
// 65 条约覆盖 15 分钟间隔的 16 小时，足以呈现当前心跳条。
export async function listModelHealth(): Promise<Record<string, ModelHealthRecordView[]>> {
  const rows = await prisma.modelHealthCheck.findMany({
    where: { checkedAt: { gte: new Date(Date.now() - API_HISTORY_MS) } },
    orderBy: { checkedAt: "desc" },
    take: 50_000,
  });
  const out: Record<string, ModelHealthRecordView[]> = {};
  for (const row of rows) {
    const list = out[row.modelKey] ?? (out[row.modelKey] = []);
    if (list.length >= API_HISTORY_LIMIT) continue;
    list.push({
      ok: row.ok,
      status: row.status,
      latency_ms: row.latencyMs,
      completion_tokens: row.completionTokens,
      tokens_per_second: row.tokensPerSecond,
      error_kind: row.errorKind,
      detail: row.detail,
      checked_at: row.checkedAt.toISOString(),
    });
  }
  for (const list of Object.values(out)) list.reverse();
  return out;
}

async function executeProbe(source: string, modelKey: string): Promise<ModelHealthRunResult> {
  const started = Date.now();
  const cfg = await getConfig();
  const selected = modelKey.trim();
  const focused = selected ? await discoverTarget(cfg, selected) : null;
  const { targets, catalogErrors } = selected
    ? { targets: focused ? [focused] : [], catalogErrors: 0 }
    : await discoverTargets(cfg);
  let ok = 0;
  let failed = 0;

  await mapLimit(targets, PROBE_CONCURRENCY, async (target) => {
    const outcome = await probeTarget(cfg, target);
    try {
      const check = await prisma.modelHealthCheck.create({
        data: {
          modelKey: target.key,
          ok: outcome.ok,
          status: Math.max(0, Math.trunc(outcome.status)),
          latencyMs: Math.max(0, Math.trunc(outcome.latencyMs)),
          completionTokens: Math.max(0, Math.trunc(outcome.completionTokens)),
          tokensPerSecond: Math.max(0, outcome.tokensPerSecond),
          errorKind: outcome.errorKind.slice(0, 80),
          detail: outcome.detail.slice(0, 500),
          source: source.slice(0, 40),
        },
        select: { id: true },
      });
      const latency = outcome.latencyMs >= 1000
        ? (outcome.latencyMs / 1000).toFixed(1) + "s"
        : outcome.latencyMs + "ms";
      runlog(
        "[probe] " + target.key + " " + (outcome.ok ? "成功" : "失败") +
        " HTTP " + Math.max(0, Math.trunc(outcome.status)) +
        " · 延迟 " + latency +
        " · 吞吐 " + outcome.tokensPerSecond + " t/s" +
        " · 输出 " + Math.max(0, Math.trunc(outcome.completionTokens)) + " tok" +
        " · source=" + source.slice(0, 40) +
        (!outcome.ok && outcome.errorKind ? " · kind=" + outcome.errorKind : "") +
        (!outcome.ok && outcome.detail
          ? " · " + outcome.detail.replace(/\s+/g, " ").slice(0, 160)
          : ""),
        check.id,
      );
      if (outcome.ok) ok++;
      else failed++;
    } catch (e) {
      failed++;
      runlog("modelhealth save " + target.key + ": " + errMsg(e));
    }
  });

  await prisma.modelHealthCheck.deleteMany({
    where: { checkedAt: { lt: new Date(Date.now() - HEALTH_RETENTION_MS) } },
  }).catch((e) => {
    runlog("modelhealth cleanup: " + errMsg(e));
  });

  const result = {
    total: targets.length,
    ok,
    failed,
    catalogErrors,
    durationMs: Date.now() - started,
  };
  runlog(
    "modelhealth 完成: " + ok + " 成功 / " + failed + " 失败 · 模型 " +
    targets.length + " · " + result.durationMs + "ms",
  );
  return result;
}

// discoverTarget 只解析手动选中的模型，避免单项探测重新拉取整份模型目录。
async function discoverTarget(cfg: AppConfig, modelKey: string): Promise<HealthTarget | null> {
  const ci = modelKey.indexOf(":");
  const prefix = ci > 0 ? modelKey.slice(0, ci) : "";
  const bare = ci > 0 ? modelKey.slice(ci + 1) : modelKey;
  if (!bare) return null;

  if (prefix === "cn" || prefix === "global" || prefix === "") {
    const realm = prefix === "global" ? "global" : "cn";
    const accounts = await prisma.account.findMany({
      where: {
        accessToken: { not: "" },
        state: { is: { disabled: false, paused: false } },
      },
      orderBy: { createdAt: "asc" },
    });
    const account = accounts.find((a) => realmOf(a) === realm);
    if (!account) return null;
    return {
      channel: "pool",
      key: realm + ":" + bare,
      model: bare,
      shape: authShapeOf(account),
    };
  }

  const provider = await prisma.provider.findUnique({ where: { name: prefix } });
  if (!provider) return null;
  return {
    channel: "provider",
    key: modelKey,
    model: bare,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
  };
}

async function discoverTargets(cfg: AppConfig): Promise<{
  targets: HealthTarget[];
  catalogErrors: number;
}> {
  const targets = new Map<string, HealthTarget>();
  let catalogErrors = 0;
  const accounts = await prisma.account.findMany({
    where: {
      accessToken: { not: "" },
      state: { is: { disabled: false, paused: false } },
    },
    include: { state: true },
    orderBy: { createdAt: "asc" },
  });

  // 与面板模型目录同口径：CN/global 各选第一个能成功拉取目录的可用账号。
  for (const realm of ["cn", "global"] as const) {
    const candidates = accounts.filter((a) => realmOf(a) === realm);
    for (const account of candidates) {
      try {
        const shape = authShapeOf(account);
        let models: string[];
        if (realm === "global") {
          models = (await fetchGlobalModelInfos(cfg, shape)).names;
        } else {
          models = (await fetchModelsFull(cfg, shape)).map((m) => m.id);
        }
        models = [...new Set(models.filter(Boolean))];
        if (models.length === 0) throw new Error("模型目录为空");
        for (const model of models) {
          const key = realm + ":" + model;
          targets.set(key, { channel: "pool", key, model, shape });
        }
        break;
      } catch (e) {
        catalogErrors++;
        runlog("modelhealth catalog " + realm + ": " + errMsg(e));
      }
    }
  }

  const providerErrors: string[] = [];
  try {
    const models = await providerModels(undefined, providerErrors);
    const providers = await prisma.provider.findMany();
    const byName = new Map(providers.map((p) => [p.name, p]));
    for (const model of models) {
      const provider = byName.get(model.owned_by);
      if (!provider) continue;
      const bare = model.id.startsWith(provider.name + ":")
        ? model.id.slice(provider.name.length + 1) : model.id;
      targets.set(model.id, {
        channel: "provider",
        key: model.id,
        model: bare,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
      });
    }
  } catch (e) {
    catalogErrors++;
    providerErrors.push(errMsg(e));
  }
  for (const error of providerErrors) runlog("modelhealth catalog provider: " + error);

  return { targets: [...targets.values()], catalogErrors };
}

async function probeTarget(
  cfg: AppConfig,
  target: HealthTarget,
): Promise<ProbeOutcome> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("health probe timeout", "TimeoutError")),
    PROBE_TIMEOUT_MS,
  );
  try {
    const outcome = target.channel === "pool"
      ? await probePoolTarget(cfg, target, controller.signal)
      : await probeProviderTarget(target, controller.signal);
    return outcome;
  } catch (e) {
    return {
      ok: false,
      status: 0,
      errorKind: controller.signal.aborted ? "timeout" : "transport",
      detail: errMsg(e),
      latencyMs: Date.now() - started,
      completionTokens: 0,
      tokensPerSecond: 0,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function probePoolTarget(
  cfg: AppConfig,
  target: PoolTarget,
  signal: AbortSignal,
): Promise<ProbeOutcome> {
  const started = Date.now();
  const id = randomUUID();
  const res = await chatStream(
    cfg,
    target.shape,
    probeBody(target.model),
    "",
    {
      conversationID: "health-" + id,
      cacheKeyID: "",
      conversationRequestID: "health:" + id,
      traceID: "health:" + id,
    },
    signal,
  );
  if (!res.ok || !res.body) {
    const body = res.respBody ?? "";
    return {
      ok: false,
      status: res.status,
      errorKind: errorKindOf(res.status, body),
      detail: body || "upstream returned no response stream",
      latencyMs: Date.now() - started,
      completionTokens: 0,
      tokensPerSecond: 0,
    };
  }
  const frame = await readHealthFrame(res.body, signal, started);
  return {
    ok: frame.ok,
    status: res.status,
    errorKind: frame.ok ? "" : frame.errorKind,
    detail: frame.detail,
    latencyMs: frame.latencyMs,
    completionTokens: frame.completionTokens,
    tokensPerSecond: frame.tokensPerSecond,
  };
}

async function probeProviderTarget(
  target: ProviderTarget,
  signal: AbortSignal,
): Promise<ProbeOutcome> {
  const started = Date.now();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (target.apiKey) headers.Authorization = "Bearer " + target.apiKey;
  const resp = await fetch(providerEndpoint(target.baseUrl, "/chat/completions"), {
    method: "POST",
    headers,
    body: probeBody(target.model),
    signal,
  });
  if (!resp.ok || !resp.body) {
    const body = await resp.text().catch(() => "");
    return {
      ok: false,
      status: resp.status,
      errorKind: errorKindOf(resp.status, body),
      detail: body || "provider returned no response stream",
      latencyMs: Date.now() - started,
      completionTokens: 0,
      tokensPerSecond: 0,
    };
  }
  const frame = await readHealthFrame(resp.body, signal, started);
  return {
    ok: frame.ok,
    status: resp.status,
    errorKind: frame.ok ? "" : frame.errorKind,
    detail: frame.detail,
    latencyMs: frame.latencyMs,
    completionTokens: frame.completionTokens,
    tokensPerSecond: frame.tokensPerSecond,
  };
}

function probeBody(model: string): string {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: "ping" }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 16,
  });
}

// readHealthFrame 严格要求拿到 choices/有效响应；仅收到 HTTP 200 但没有有效帧
// 不算可用，避免把挂起的流误统计为成功。拿到首个有效帧后继续收集到结束帧，
// 用于记录本次真实输出的 token 数与生成吞吐。
async function readHealthFrame(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  startedAt: number,
): Promise<{
  ok: boolean; errorKind: string; detail: string;
  latencyMs: number; completionTokens: number; tokensPerSecond: number;
}> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let valid = false;
  let firstFrameAt = 0;
  let firstContentAt = 0;
  let contentChars = 0;
  let contentChunks = 0;
  let usageTokens = 0;
  let finishedAt = 0;

  const finish = (ok: boolean, errorKind = "", detail = "") => {
    const endedAt = Date.now();
    // finish_reason 可能先于 usage 帧到达；吞吐以真实结束帧计时，最多再等 1s 收 usage。
    const generationEndedAt = finishedAt || endedAt;
    const completionTokens = ok
      ? usageTokens || (contentChars > 0
        ? Math.max(contentChunks, Math.ceil(contentChars / 4))
        : 0)
      : 0;
    const generationStartedAt = firstContentAt || firstFrameAt || endedAt;
    const generationMs = Math.max(0, generationEndedAt - generationStartedAt);
    const tokensPerSecond = ok && completionTokens > 0 && generationMs > 0
      ? Math.round((completionTokens / generationMs) * 10_000) / 10
      : 0;
    return {
      ok,
      errorKind,
      detail: detail.trim().slice(0, 500),
      latencyMs: Math.max(0, (firstFrameAt || endedAt) - startedAt),
      completionTokens,
      tokensPerSecond,
    };
  };

  const consume = (data: string) => {
    if (!data || data === "[DONE]") return null;
    if (isModelRateLimit(data)) return finish(false, "soft_rate", data);
    if (isQueueWait(data)) return finish(false, "soft_queue", data);
    let obj: {
      error?: unknown;
      code?: unknown;
      choices?: {
        delta?: { content?: unknown; reasoning_content?: unknown };
        message?: { content?: unknown };
        finish_reason?: unknown;
      }[];
      usage?: { completion_tokens?: unknown; output_tokens?: unknown };
    };
    try {
      obj = JSON.parse(data) as typeof obj;
    } catch {
      return null;
    }
    const hasError = Boolean(obj.error) ||
      (typeof obj.code === "number" && obj.code !== 0) ||
      (typeof obj.code === "string" && obj.code !== "" && obj.code !== "0");
    if (hasError) {
      const kind = classify(400, data);
      return finish(false, kind === "none" ? "client" : kind, data);
    }
    const usage = obj.usage?.completion_tokens ?? obj.usage?.output_tokens;
    if (typeof usage === "number" && usage > 0) usageTokens = usage;
    if (!Array.isArray(obj.choices) || obj.choices.length === 0) return null;

    valid = true;
    if (firstFrameAt === 0) firstFrameAt = Date.now();
    let finished = false;
    for (const choice of obj.choices) {
      const text = [
        choice.delta?.content,
        choice.delta?.reasoning_content,
        choice.message?.content,
      ].find((v): v is string => typeof v === "string" && v.length > 0);
      if (text) {
        if (firstContentAt === 0) firstContentAt = Date.now();
        contentChars += text.length;
        contentChunks++;
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined && choice.finish_reason !== "") {
        finished = true;
      }
    }
    if (finished && finishedAt === 0) finishedAt = Date.now();
    return null;
  };

  try {
    for (;;) {
      if (signal.aborted) return finish(false, "timeout", "probe timed out waiting for response");
      const waitMs = finishedAt > 0
        ? Math.max(0, Math.min(FRAME_WAIT_MS, finishedAt + FINAL_USAGE_WAIT_MS - Date.now()))
        : FRAME_WAIT_MS;
      if (waitMs === 0) return finish(true);
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      const wait = new Promise<"wait">((resolve) => {
        waitTimer = setTimeout(() => resolve("wait"), waitMs);
      });
      const got = await Promise.race([reader.read(), wait]);
      if (waitTimer) clearTimeout(waitTimer);
      if (got === "wait") {
        return valid
          ? finish(true)
          : finish(false, "timeout", "no response frame within " + FRAME_WAIT_MS + "ms");
      }
      if (got.done) {
        buf += decoder.decode();
        const line = buf.trim();
        if (line) {
          const data = line.startsWith("data:") ? line.slice(5).trim() : line;
          const parsed = data === "[DONE]" ? finish(valid, valid ? "" : "bad_response",
            valid ? "" : "response stream ended without a valid frame") : consume(data);
          if (parsed) return parsed;
        }
        return valid
          ? finish(true)
          : finish(false, "bad_response", "response stream ended without a valid frame");
      }
      buf += decoder.decode(got.value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        const data = line.startsWith("data:") ? line.slice(5).trim() : line;
        if (!data) continue;
        if (data === "[DONE]") {
          return valid
            ? finish(true)
            : finish(false, "bad_response", "response stream ended without a valid frame");
        }
        const parsed = consume(data);
        if (parsed) return parsed;
      }
    }
  } catch (e) {
    return finish(false, signal.aborted ? "timeout" : "transport", errMsg(e));
  } finally {
    try { await reader.cancel(); } catch { /* stream may already be closed */ }
    try { reader.releaseLock(); } catch { /* reader may still be held by abort */ }
  }
}

function errorKindOf(status: number, body: string): string {
  if (isModelRateLimit(body)) return "soft_rate";
  if (isQueueWait(body)) return "soft_queue";
  const kind = classify(status, body);
  if (kind !== "none") return kind;
  if (status >= 400) return "client";
  return "transport";
}

function realmOf(account: { realm: string }): "cn" | "global" {
  return account.realm === "global" ? "global" : "cn";
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
