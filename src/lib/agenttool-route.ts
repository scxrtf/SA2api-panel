// agenttool 路由族共用逻辑（/v1/search 与 /v1/fetch，移植 internal/server/search.go
// 与 fetch.go 的取号与失败处置：单次取号、失败换号上限 3、请求级错误 fail-fast、
// realm 解析同口径）。
import { getConfig } from "./config";
import { sleepAbortable } from "./backoff";
import * as pool from "./pool";
import { authShapeOf } from "./login";
import { UpstreamError, type ErrKind } from "./upstream/errors";
import type { AppConfig } from "./config";
import type { AuthShape } from "./upstream/client";
import { openAIError } from "./chat";

const ATTEMPTS = 3;
// 换号预算至少覆盖当前可用账号：账号级 429 只影响当前号，池里还有号时
// 固定 3 次会提前把可用账号判成耗尽（大池场景与 chat 轮转同根因）。
const ATTEMPTS_HARD_CAP = 64;

// 请求级错误：换号必然同样被拒，直接透传上游原文（不烧全池）。
const failFastKinds: ErrKind[] = [
  "bad_params", "image_invalid", "prompt_too_long", "content_blocked", "model_blocked",
  "account_fault", "client",
];

// resolveRealm 与 /v1/search 同口径："realm" 优先于 "model" 的 cn:/global: 前缀，
// 其余一律回落 cn。
export function resolveRealm(model: unknown, realm: unknown): string {
  let r = "";
  if (typeof model === "string") {
    const m = model.trim();
    if (m.toLowerCase().startsWith("global:")) r = "global";
    else if (m.toLowerCase().startsWith("cn:")) r = "cn";
  }
  if (typeof realm === "string" && realm.trim() !== "") r = realm.trim();
  return r === "global" ? "global" : "cn";
}

export interface AgentToolOutcome {
  status: number;
  code: string;
  msg: string;
  data?: string; // 上游原文（成功）
  retryAfterMs?: number;
}

// runAgentTool 取号执行一次 agenttool 调用，带 3 次换号。
export async function runAgentTool(
  realm: string,
  call: (cfg: AppConfig, auth: AuthShape) => Promise<string>,
  signal?: AbortSignal,
): Promise<AgentToolOutcome> {
  const cfg = await getConfig();
  const capacityDeadline = Date.now() + cfg.pool_wait_ms;
  const tried = new Set<string>();
  let lastErr: UpstreamError | Error | null = null;
  let retryAfterMs = 0;
  let queueRetryRounds = 0;
  const MAX_QUEUE_RETRY_ROUNDS = 3;
  const available = await pool.availableCountForModel("", realm);
  let budget = Math.min(Math.max(ATTEMPTS, available), ATTEMPTS_HARD_CAP);
  for (let attempt = 0; attempt < budget; attempt++) {
    if (signal?.aborted) break;
    const entry = await pool.pick(cfg, { tried, realm });
    if (!entry) {
      const remaining = capacityDeadline - Date.now();
      const capacity = await pool.capacityWaitStatus(cfg, { realm, tried }, remaining);
      if (capacity.waitMs > 0 && await sleepAbortable(capacity.waitMs, signal)) {
        if (capacity.reason === "queue") {
          if (queueRetryRounds >= MAX_QUEUE_RETRY_ROUNDS) break;
          queueRetryRounds++;
          budget += tried.size;
          tried.clear();
        }
        attempt--; // 容量等待不消耗换号预算。
        continue;
      }
      if (capacity.reason === "queue") retryAfterMs = capacity.nextRetryMs;
      const unavailable = await pool.retryStatus("", realm);
      retryAfterMs = unavailable.retryAfterMs || retryAfterMs;
      if (unavailable.accountCooling > 0) {
        return {
          status: 429,
          code: "rate_limit_exceeded",
          msg: lastErr?.message || "all candidate accounts are cooling down, please retry later",
          retryAfterMs,
        };
      }
      break;
    }
    if (tried.size === 0 && lastErr) break;
    if (!pool.acquire(entry, cfg)) {
      const remaining = capacityDeadline - Date.now();
      const capacity = await pool.capacityWaitStatus(cfg, { realm, tried }, remaining);
      if (capacity.waitMs > 0 && await sleepAbortable(capacity.waitMs, signal)) {
        if (capacity.reason === "queue") {
          if (queueRetryRounds >= MAX_QUEUE_RETRY_ROUNDS) break;
          queueRetryRounds++;
          budget += tried.size;
          tried.clear();
        }
        attempt--;
      }
      continue;
    }
    tried.add(entry.account.uid);
    const auth = authShapeOf(entry.account);
    try {
      const data = await call(cfg, auth);
      await pool.noteSuccess(entry.account.uid).catch(() => undefined);
      return { status: 200, code: "", msg: "", data };
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (e instanceof UpstreamError) {
        if (e.retryAfterMs > 0 &&
          (retryAfterMs <= 0 || e.retryAfterMs < retryAfterMs)) {
          retryAfterMs = e.retryAfterMs;
        }
        // 与 chat/images 同一套失败处置（冷却/熔断/模型负缓存/12153 计数）。
        await pool.applyErrorKind(cfg, entry.account.uid, e.kind, e.message, "", e.retryAfterMs)
          .catch(() => undefined);
        if (failFastKinds.includes(e.kind)) {
          const status = e.status >= 400 ? e.status : 400;
          return { status, code: "upstream_error", msg: e.message };
        }
      }
    } finally {
      pool.release(entry.account.uid);
    }
  }
  // 上游可能在 HTTP 200 业务信封里返回 6020/限流，对客户端仍应映射为 429。
  const status = lastErr instanceof UpstreamError &&
    (lastErr.kind === "soft_queue" || lastErr.kind === "soft_rate")
    ? 429
    : lastErr instanceof UpstreamError && lastErr.status >= 400 ? lastErr.status : 502;
  if (status === 429) retryAfterMs = (await pool.retryStatus("", realm)).retryAfterMs || retryAfterMs;
  return {
    status,
    code: status === 429 ? "rate_limit_exceeded" : "upstream_error",
    msg: lastErr instanceof Error ? lastErr.message : "upstream failed",
    retryAfterMs,
  };
}

export function agentToolError(o: AgentToolOutcome): Response {
  return openAIError(o.status, o.code, o.msg, undefined,
    o.status === 429 && (o.retryAfterMs ?? 0) > 0
      ? { "Retry-After": String(Math.max(1, Math.ceil((o.retryAfterMs ?? 0) / 1000))) }
      : undefined);
}

// deepSeekSearchClient 判定请求是否来自 DSH（DeepSeek Harness）。兼容补丁只对这类
// 客户端启用（UA 实测 "deepseek-harness/0.2.1-rc.2 (+https://…)"），其余客户端保持
// 上游原文逐字节透传，避免为不需要该字段的调用方改动字段集合。
export function deepSeekSearchClient(ua: string): boolean {
  return ua.toLowerCase().includes("deepseek-harness");
}

// compatDeepSeekSearch 把上游原文补成 DeepSeek Search API 兼容形状（仅 DSH）：
// results[].date 缺失 → null；title/snippet 缺失或 null → ""。
// 依据：DSH 用 `item.date !== null && typeof item.date !== 'string'` 判定，字段缺失
// （undefined）会直接抛 invalidResponse。
export function compatDeepSeekSearch(raw: string): string {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return raw;
  }
  const results = obj["results"];
  if (!Array.isArray(results) || results.length === 0) return raw;
  for (const it of results) {
    if (!it || typeof it !== "object") continue;
    const item = it as Record<string, unknown>;
    if (!("date" in item)) item["date"] = null;
    if (!("title" in item) || item["title"] === null) item["title"] = "";
    if (!("snippet" in item) || item["snippet"] === null) item["snippet"] = "";
  }
  return JSON.stringify(obj);
}
