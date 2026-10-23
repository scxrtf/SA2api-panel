// Chat 主流程（移植 internal/server/handler.go chatCompletions）：
// resolveModel → provider 分流 → 粘性解析 → 轮转选号 → refresh → chatStream →
// 错误分类处置（降级重写/透传 400/冷却熔断/换号）→ 成功才 NoteSuccess+绑粘性 →
// 流式透传 / 非流式聚合 → 记账。末端错误映射与 Go 同口径。
import { prisma } from "./db";
import { getConfig, type AppConfig } from "./config";
import * as pool from "./pool";
import { deriveID } from "./upstream/desktop";
import {
  extractKey,
  turnKey,
  resolveConversationID,
  deriveKey,
  resolveSticky,
  bindSticky,
  unbindSticky,
} from "./session";
import {
  chatStream,
  refreshToken,
  requestIDForKey,
  newTraceID,
  type ChatMeta,
  type AuthShape,
} from "./upstream/client";
import {
  classify,
  UpstreamError,
  gatewayHint,
  noHealthyAccountHint,
  frameHint,
  type HintContext,
  type ErrKind,
} from "./upstream/errors";
import { catalogSupportsImages } from "./upstream/modelCatalog";
import {
  streamPassthrough,
  aggregate,
  StreamPassthroughError,
  type StreamStats,
} from "./upstream/sse";
import { tokensPerSecond } from "./upstream/usage";
import { currentModelRate } from "./upstream/modelCatalog";
import { toolNameAllowlist, MarkupRepair, repairAggregatedResponse } from "./upstream/dsml";
import { runlog } from "./runlog";
import { markRunlogPersisted } from "./runlog";
import * as wafip from "./wafip";
import { backoffAfter, sleep } from "./backoff";
import { identifyKeyIdentity, providerAllowed } from "./auth-guard";
import { maybeProbeAfterModelCall } from "./model-health-trigger";
import {
  assistantMessageForLog,
  errorText,
  failureDetail,
  parameterOverrides,
  requestMessagesForLog,
  responseMessageFromObject,
  type AttemptDetail,
} from "./request-log-detail";

type Obj = Record<string, unknown>;

// ─── resolveModel（resolve_model.go 同语义） ─────────────────────────────

export function resolveModel(model: string): { realm: string; provider: string; bare: string } {
  const idx = model.indexOf(":");
  if (idx < 0) return { realm: "cn", provider: "", bare: model };
  const prefix = model.slice(0, idx);
  if (prefix === "cn" || prefix === "global") {
    return { realm: prefix, provider: "", bare: model.slice(idx + 1) };
  }
  return { realm: "", provider: prefix, bare: model.slice(idx + 1) };
}

// ─── 降级重写（content_blocked 指纹误报抢救，degrade.go 简化口径） ────────
// 降级期：首次 content_blocked 触发，持续到次日 00:00（Asia/Shanghai）。
let degradeUntil = 0;

function degradeActive(): boolean {
  return Date.now() < degradeUntil;
}

function triggerDegrade(): void {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  // 次日 00:00 CST。
  const midnight = new Date(parts + "T00:00:00+08:00").getTime() + 24 * 3600_000;
  degradeUntil = midnight;
}

const DEGRADED_PROMPT =
  "You are a helpful coding assistant. Answer concisely and accurately.";

// rewriteSystemPrompt 用中性提示词替换全部 system/developer 消息（prompt.Rewrite 口径）。
function rewriteSystemPrompt(body: Obj, prompt: string): string {
  const msgs = Array.isArray(body["messages"]) ? (body["messages"] as Obj[]) : [];
  const kept = msgs.filter((m) => {
    const role = (m as Obj)["role"];
    return role !== "system" && role !== "developer";
  });
  const out = { ...body, messages: [{ role: "system", content: prompt }, ...kept] };
  return JSON.stringify(out);
}

function applyPromptMode(cfg: AppConfig, body: Obj): string {
  const mode = cfg.prompt_mode;
  if (mode === "custom" && cfg.prompt_text) {
    return rewriteSystemPrompt(body, cfg.prompt_text);
  }
  if (mode === "append" && cfg.prompt_text && !degradeActive()) {
    const msgs = Array.isArray(body["messages"]) ? (body["messages"] as Obj[]) : [];
    // 开头连续 system/developer 块后插自有提示词，既有消息逐字不动。
    let i = 0;
    while (i < msgs.length) {
      const role = (msgs[i] as Obj)["role"];
      if (role === "system" || role === "developer") i++;
      else break;
    }
    const next = [
      ...msgs.slice(0, i),
      { role: "system", content: cfg.prompt_text },
      ...msgs.slice(i),
    ];
    return JSON.stringify({ ...body, messages: next });
  }
  if ((mode === "passthrough" || mode === "append") && degradeActive()) {
    return rewriteSystemPrompt(body, DEGRADED_PROMPT);
  }
  return JSON.stringify(body);
}

function rewriteModel(bodyStr: string, bare: string): string {
  try {
    const obj = JSON.parse(bodyStr) as Obj;
    obj["model"] = bare;
    return JSON.stringify(obj);
  } catch {
    return bodyStr;
  }
}

// hasImagePart 请求体是否携带 image_url part（11133「模型不支持图片」指向的前提）。
// 在提示词/模型名改写之前取（改写不动 messages[].content 子树）。
function hasImagePart(body: Obj): boolean {
  const msgs = body["messages"];
  if (!Array.isArray(msgs)) return false;
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    const content = (m as Obj)["content"];
    if (!Array.isArray(content)) continue;
    for (const p of content) {
      if (p && typeof p === "object" && (p as Obj)["type"] === "image_url") return true;
    }
  }
  return false;
}

// ─── 错误响应（OpenAI 兼容口径） ──────────────────────────────────────────

export function openAIError(
  status: number,
  code: string,
  message: string,
  hint?: string,
  headers?: HeadersInit,
): Response {
  const err: Obj = { message, type: code, code };
  if (hint) err["gateway_hint"] = hint;
  const init: ResponseInit = { status };
  if (headers) init.headers = headers;
  return Response.json({ error: err }, init);
}

// ─── 记账（UsageEvent / RequestLog） ──────────────────────────────────────

interface AttemptRec {
  uid: string;
  model: string;
  realm: string;
  provider: string;
  ok: boolean;
  errKind: string;
  stats?: Partial<StreamStats>;
  latencyMs?: number;
  tps?: number | null;
  keyName?: string;
  modelRate?: string;
}

async function recordAttempt(r: AttemptRec): Promise<void> {
  try {
    const s = r.stats;
    const tps = r.tps ?? null;
    await prisma.usageEvent.create({
      data: {
        uid: r.uid,
        model: r.model,
        realm: r.realm,
        provider: r.provider,
        promptTokens: s?.promptTokens ?? 0,
        completionTok: s?.completionTokens ?? 0,
        totalTokens: s?.totalTokens ?? 0,
        credit: s?.hasCredit ? (s?.credit ?? 0) : 0,
        hasCredit: s?.hasCredit === true,
        cacheHitTok: s?.hasCache ? (s?.cacheHitTokens ?? 0) : 0,
        cacheMissTok: s?.hasCache ? (s?.cacheMissTokens ?? 0) : 0,
        latencyMs: r.latencyMs ?? 0,
        tps: tps ?? 0,
        keyName: r.keyName ?? "",
        modelRate: r.modelRate ?? "",
        ok: r.ok,
        errKind: r.errKind,
      },
    });
  } catch {
    // 记账失败不阻断主链路。
  }
}

async function recordRequestLog(r: {
  uid: string;
  model: string;
  realm: string;
  provider: string;
  status: number;
  errKind: string;
  stream: boolean;
  durationMs: number;
  clientIp: string;
  ua: string;
  path: string;
  ttfbMs?: number;
  attempts?: number;
  promptTokens?: number;
  completionTok?: number;
  totalTokens?: number;
  credit?: number;
  hasCredit?: boolean;
  cacheHitTok?: number;
  cacheMissTok?: number;
  keyName?: string;
  slot?: string;
  machineId?: string;
  requestMessages?: unknown;
  responseMessage?: unknown;
  errorDetail?: string;
  parameterOverrides?: unknown;
  attemptDetails?: unknown;
}, logRef = ""): Promise<boolean> {
  try {
    const row = await prisma.requestLog.create({
      data: r as never,
      select: { id: true },
    });
    markRunlogPersisted(logRef, row.id);
    return true;
  } catch {
    // 同上。
    return false;
  }
}

// ─── 低命中率告警信号（Go logging.go cacheMissSignal） ────────────────────
// 同一模型此前观测到过命中、本次大前缀（≥1000 tok）整段未命中时打一条 WARN，
// 每模型 10 分钟冷却。只报「本可命中却重算」的可行动信号——新模型/新会话的
// 首请求天然全 miss，不在此列。
const CACHE_MISS_WARN_EVERY_MS = 10 * 60_000;
const cacheMissWarnState = globalThis as unknown as {
  __wbCacheEverHit?: Set<string>;
  __wbCacheWarnLast?: Map<string, number>;
};
const cacheEverHit = cacheMissWarnState.__wbCacheEverHit ?? (cacheMissWarnState.__wbCacheEverHit = new Set());
const cacheWarnLast = cacheMissWarnState.__wbCacheWarnLast ?? (cacheMissWarnState.__wbCacheWarnLast = new Map());

function noteCacheTokens(model: string, prompt: number, hit: number, miss: number): void {
  if (!model) return;
  if (hit > 0) {
    cacheEverHit.add(model);
    return;
  }
  // hit==0 才可能是整段重算。小前缀（<1000 tok）的 miss 无告警价值；上游未回
  // miss 字段时按 prompt 全量视为未命中。
  if (prompt < 1000) return;
  const m = miss > 0 ? miss : prompt;
  if (!cacheEverHit.has(model)) return;
  const now = Date.now();
  const last = cacheWarnLast.get(model) ?? 0;
  if (now - last < CACHE_MISS_WARN_EVERY_MS) return;
  cacheWarnLast.set(model, now);
  runlog(
    "WARN: cache miss: model=" + model +
    " 本次大前缀未命中（prompt=" + prompt + " miss=" + m +
    "，此前观测到过命中）；上游前缀缓存重算，费用会显著升高",
  );
}

// ─── 主流程 ───────────────────────────────────────────────────────────────

export interface ChatResult {
  response: Response;
}

// handleChat 处理一个 OpenAI chat.completions 请求。body 为已解析 JSON 对象
//（rawBody 为原始串，供不改写场景零漂移透传）。
export async function handleChat(opts: {
  body: Obj;
  clientIP: string;
  inboundHeaders: Headers;
  ua: string;
  path: string;
  req?: Request; // 原始请求（key 归属识别；Anthropic 翻译路径可缺省）
}): Promise<Response> {
  const started = Date.now();
  const cfg = await getConfig();
  const { body, clientIP, ua, path } = opts;
  const stream = body["stream"] === true;
  const rawModel = typeof body["model"] === "string" ? (body["model"] as string) : "";
  const loggedRequestMessages = requestMessagesForLog(body["messages"]);
  const attemptDetails: AttemptDetail[] = [];
  let latestOutboundOverrides = parameterOverrides(body, body);

  const { realm, provider, bare } = resolveModel(rawModel);
  // 使用者归属（Go keyNameFrom）：多 sk-key 模式下命中哪把 key 就记谁的名字；
  // 单 key / 无鉴权 / 无原始请求时为空串。一次性取值，轮转全程复用。
  // 同一身份同时携带供应商授权面，供 provider 通道做准入判定。
  const keyIdentity = opts.req ? await identifyKeyIdentity(opts.req) : null;
  const keyName = keyIdentity?.name ?? "";
  // 请求时生效积分倍率（Go handler.go:605）：目录成功刷新时缓存于 modelRates 桶。
  const modelRate = currentModelRate(realm, bare);
  // 显式供应商前缀绝不回落池：查找失败由 providerChat 返回并记录错误。
  if (provider !== "") {
    // 供应商准入：子密钥绑定白名单时只放行名单内供应商；未绑定（空）或 "*"
    // 不限制。身份缺失（无法识别 / DB 异常）仍按拒绝处理，避免借空绑定绕过。
    if (opts.req) {
      const allowed = keyIdentity
        ? keyIdentity.unrestricted || providerAllowed(keyIdentity.providers, provider)
        : false;
      if (!allowed) {
        await recordRequestLog({
          uid: "", model: rawModel, realm: "provider:" + provider, provider,
          status: 403, errKind: "provider_not_authorized", stream,
          durationMs: Date.now() - started, clientIp: clientIP, ua, path, keyName,
          attempts: 0,
          requestMessages: loggedRequestMessages,
          errorDetail: failureDetail({
            status: 403,
            code: "provider_not_authorized",
            kind: "provider_not_authorized",
            message: `key 未授权使用供应商 ${provider}`,
            stage: "provider_authorization",
          }),
        });
        return openAIError(
          403,
          "provider_not_authorized",
          `key 未授权使用供应商 ${provider}`,
          "请在面板「网关密钥环」中为该 key 勾选对应供应商授权",
        );
      }
    }
    const { providerChat } = await import("./provider");
    return providerChat(provider, bare, JSON.stringify(body), stream, keyName, rawModel,
      { started, clientIP, ua, path, signal: opts.req?.signal });
  }

  // 会话键 / 轮级键 / 粘性解析。
  const sessKey = extractKey(body);
  const tKey = turnKey(body);
  let stickyUID = "";
  if (cfg.session_sticky && sessKey) {
    stickyUID = (await resolveSticky(sessKey, bare, realm)) ?? "";
  }

  // 会话头族（issue #35）：轮转循环外生成一次，循环内复用。
  const chatMeta: ChatMeta = {
    conversationID: resolveConversationID(body),
    cacheKeyID: sessKey || deriveKey(body),
    conversationRequestID: "",
    traceID: opts.inboundHeaders.get("x-trace-id") || newTraceID(),
  };
  const inboundConvReqID = opts.inboundHeaders.get("x-conversation-request-id") ?? "";
  if (inboundConvReqID) {
    chatMeta.conversationRequestID = inboundConvReqID;
  } else if (tKey && sessKey) {
    chatMeta.conversationRequestID = requestIDForKey(sessKey + ":" + tKey);
  } else if (tKey) {
    chatMeta.conversationRequestID = requestIDForKey(tKey);
  } else if (sessKey) {
    chatMeta.conversationRequestID = requestIDForKey(sessKey);
  } else {
    chatMeta.conversationRequestID = requestIDForKey("");
  }

  // 系统提示词改写（每个请求一次，轮转前）。
  let outBody = applyPromptMode(cfg, body);
  let degradedApplied = degradeActive() && (cfg.prompt_mode === "passthrough" || cfg.prompt_mode === "append");
  if (bare !== rawModel) outBody = rewriteModel(outBody, bare);
  const snapshotOutbound = (raw: string) => {
    try {
      latestOutboundOverrides = parameterOverrides(body, JSON.parse(raw));
    } catch {
      latestOutboundOverrides = [];
    }
  };
  snapshotOutbound(outBody);

  // gateway_hint 判定所需的请求形态（image_url part）：在改写前取（与 Go 同理）。
  const reqHasImage = hasImagePart(body);

  // hintContext 组装 gateway_hint 判定上下文：裸模型名 + 是否带图 + 目录
  // supports_images 声明。目录查询只读静态表（catalogSupportsImages），绝不触发
  // 上游拉取——错误路径加一次网络调用既拖慢错误响应又放大请求量（与 WAF IP
  // fail-fast「不放大请求量」哲学相悖）；表内未收录 → modelInCatalog=false，
  // 11133 退中性 hint（宁缺勿滥，不编造能力事实）。
  const hintContext = (): HintContext => {
    const ctx: HintContext = { model: bare, hasImage: reqHasImage };
    const si = catalogSupportsImages(bare);
    if (si !== undefined) {
      ctx.modelInCatalog = true;
      ctx.modelSupportsImages = si;
    }
    return ctx;
  };
  // hintOf 末端错误透传的统一 hint 入口：kind + 上游原文 + 请求上下文 →
  // gateway_hint 文案（gatewayHint 单一事实来源）。
  const hintOf = (kind: ErrKind, msg: string): string =>
    gatewayHint(kind, msg, hintContext());

  // 工具名名单（Go handler.go:591 同语义）：上游在没有 tools 的请求里会把工具调用
  // 吐成原生标记文本（见 upstream/dsml.ts），修复层用它做严格判定。名单来自本请求
  // 声明的 tools 与会话历史里出现过的工具名两个来源——tools 声明会在中转环节丢失，
  // 只认前者会让修复层在最需要它的场景下失效。提示词/模型名改写不动 tools 子树。
  const declaredTools = toolNameAllowlist(outBody);

  const tried = new Set<string>();
  let lastErr: { kind: ErrKind; status: number; msg: string; retryAfterMs: number } | null = null;
  let modelBlock: pool.ModelBlockStatus | null = null;
  let heldUID = "";

  const releaseHeld = () => {
    if (heldUID) {
      pool.release(heldUID);
      heldUID = "";
    }
  };
  const fail = (uid: string) => {
    releaseHeld();
    if (stickyUID && uid === stickyUID) {
      void unbindSticky(sessKey);
      stickyUID = "";
    }
  };

  let attemptCount = 0;
  const finishLog = (
    status: number,
    uid: string,
    errKind: string,
    extra?: Partial<StreamStats>,
    detailOverride?: string,
    responseOverride?: Record<string, unknown> | null,
    durationOverride?: number,
  ) => {
    const logRef = runlog(
      "[call] " + bare + " " + (status < 400 && !errKind ? "成功" : "失败") +
      " HTTP " + status + (uid ? " uid=" + uid : "") +
      (errKind ? " kind=" + errKind : "") +
      " " + (Date.now() - started) + "ms",
    );
    const failed = status >= 400 || errKind !== "";
    const responseMessage = responseOverride !== undefined
      ? responseOverride
      : extra ? assistantMessageForLog({
        role: extra.assistantRole,
        content: extra.assistantContent,
        reasoningContent: extra.assistantReasoning,
        toolCalls: extra.assistantToolCalls,
      }) : null;
    let detail = detailOverride ?? "";
    if (failed && !detail) {
      detail = failureDetail({
        status,
        code: errKind || "upstream_error",
        kind: errKind,
        message: status === 200 && errKind
          ? "上游在 HTTP 200 流中返回错误"
          : "请求失败",
        upstream: extra?.errorFrame || "",
      });
    }
    void recordRequestLog({
      uid, model: rawModel, realm, provider: "",
      status, errKind, stream,
      durationMs: Math.max(1, durationOverride ?? Date.now() - started),
      clientIp: clientIP, ua, path,
      ttfbMs: extra?.ttfbMs ? extra.ttfbMs + logAttemptStarted - started : 0,
      attempts: attemptCount,
      promptTokens: extra?.promptTokens ?? 0,
      completionTok: extra?.completionTokens ?? 0,
      totalTokens: extra?.totalTokens ?? 0,
      credit: extra?.hasCredit ? (extra?.credit ?? 0) : 0,
      hasCredit: extra?.hasCredit === true,
      cacheHitTok: extra?.hasCache ? (extra?.cacheHitTokens ?? 0) : 0,
      cacheMissTok: extra?.hasCache ? (extra?.cacheMissTokens ?? 0) : 0,
      keyName,
      // 机器码 = 实际用号按 desktop.go deriveID("machine") 同盐派生（sha36 截 36 hex）。
      // uid 为空（选号前失败 / 供应商直连）时留空，与 Go 请求日志"账号列 + 派生"口径一致。
      machineId: uid ? deriveID({ uid }, "machine") : "",
      requestMessages: loggedRequestMessages,
      responseMessage: responseMessage ?? undefined,
      errorDetail: detail,
      parameterOverrides: latestOutboundOverrides.length ? latestOutboundOverrides : undefined,
      attemptDetails: attemptDetails.length ? attemptDetails : undefined,
    }, logRef).then((saved) => {
      if (saved) void maybeProbeAfterModelCall({ realm, provider: "", bare });
    });
  };

  let logAttemptStarted = started;
  try {
    for (let i = 0; i < cfg.max_rotate; i++) {
      // 选号：粘性优先，否则普通轮换。
      let entry: pool.PoolEntry | null = null;
      if (stickyUID) {
        entry = await pool.pickByUIDForModel(cfg, stickyUID, bare);
        if (!entry || (realm !== "" && entry.account.realm !== realm)) {
          void unbindSticky(sessKey);
          stickyUID = "";
          entry = null;
        }
      }
      if (!entry) {
        entry = await pool.pick(cfg, { tried, model: bare, realm });
      }
      if (!entry) {
        modelBlock = await pool.modelBlocked(bare);
        break;
      }
      const acct = entry.account;
      tried.add(acct.uid);
      attemptCount++;

      if (!pool.acquire(entry, cfg)) {
        if (stickyUID && acct.uid === stickyUID) {
          void unbindSticky(sessKey);
          stickyUID = "";
        }
        // 名额被并发抢走 → 换号；先退避（Go rotateBackoff 同位，打散并发重试相位）。
        await sleep(backoffAfter(i));
        continue;
      }
      heldUID = acct.uid;

      const authShape: AuthShape = {
        uid: acct.uid,
        nickname: acct.nickname,
        realm: acct.realm,
        accessToken: acct.accessToken,
        refreshToken: acct.refreshToken,
        expiresAt: Number(acct.expiresAt),
        domain: acct.domain,
        enterpriseId: acct.enterpriseId,
        deviceToken: acct.deviceToken,
      };

      // token 临近过期 → 先 refresh（失败冷却换号）。
      const { needsRefresh } = await import("./upstream/client");
      if (needsRefresh(authShape, cfg.refresh_skew_sec)) {
        const refreshStarted = Date.now();
        try {
          const patch = await refreshToken(cfg, authShape);
          await prisma.account.update({
            where: { uid: acct.uid },
            data: {
              accessToken: patch.accessToken ?? acct.accessToken,
              refreshToken: patch.refreshToken ?? acct.refreshToken,
              expiresAt: BigInt(patch.expiresAt ?? Number(acct.expiresAt)),
              domain: patch.domain ?? acct.domain,
            },
          });
          authShape.accessToken = patch.accessToken ?? authShape.accessToken;
          if (patch.refreshToken) authShape.refreshToken = patch.refreshToken;
          if (patch.expiresAt) authShape.expiresAt = patch.expiresAt;
        } catch (e) {
          const kind = e instanceof UpstreamError ? e.kind : "client";
          lastErr = {
            kind,
            status: e instanceof UpstreamError ? e.status : 0,
            msg: e instanceof Error ? e.message : String(e),
            retryAfterMs: 0,
          };
          if (kind === "session_dead") {
            await pool.disable(acct.uid, "refresh session dead");
          } else {
            await pool.noteError(cfg, acct.uid);
          }
          await recordAttempt({
            uid: acct.uid, model: bare, realm, provider: "",
            ok: false, errKind: kind,
          });
          attemptDetails.push({
            attempt: attemptCount,
            uid: acct.uid,
            status: lastErr.status,
            ok: false,
            errKind: kind,
            durationMs: Math.max(1, Date.now() - refreshStarted),
            error: errorText(e),
          });
          fail(acct.uid);
          await sleep(backoffAfter(i)); // refresh 失败换号退避
          continue;
        }
      }

      const attemptStarted = Date.now();
      logAttemptStarted = attemptStarted;
      let res;
      try {
        res = await chatStream(cfg, authShape, outBody, clientIP, chatMeta);
        snapshotOutbound(res.preparedBody);
      } catch (e) {
        // 传输层失败：不换号语义区分超时——AbortError/超时不停轮换止损；
        // 其他网络抖动换号 + 喂连败计数（不罚熔断）。
        await recordAttempt({
          uid: acct.uid, model: bare, realm, provider: "",
          ok: false, errKind: "transport",
        });
        fail(acct.uid);
        const isTimeout =
          e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        attemptDetails.push({
          attempt: attemptCount,
          uid: acct.uid,
          status: isTimeout ? 503 : 0,
          ok: false,
          errKind: isTimeout ? "upstream_timeout" : "transport",
          durationMs: Math.max(1, Date.now() - attemptStarted),
          error: errorText(e),
        });
        if (isTimeout) {
          lastErr = { kind: "none", status: 0, msg: "upstream timeout", retryAfterMs: 0 };
          finishLog(503, acct.uid, "upstream_timeout", undefined, failureDetail({
            status: 503,
            code: "upstream_timeout",
            kind: "upstream_timeout",
            message: "upstream timed out: rotation stopped, please retry later",
            upstream: errorText(e),
            stage: "upstream_connect",
          }));
          return openAIError(
            503,
            "upstream_timeout",
            "upstream timed out: rotation stopped, please retry later",
          );
        }
        await pool.noteFailures(cfg, acct.uid);
        lastErr = {
          kind: "none", status: 0,
          msg: e instanceof Error ? e.message : String(e),
          retryAfterMs: 0,
        };
        await sleep(backoffAfter(i)); // 传输层错误换号退避
        continue;
      }

      if (!res.ok) {
        const status = res.status;
        const respBody = res.respBody ?? "";
        let kind: ErrKind = res.error?.kind ?? "none";
        if (kind === "none") kind = classify(status, respBody);
        await recordAttempt({
          uid: acct.uid, model: bare, realm, provider: "",
          ok: false, errKind: kind,
        });
        const attemptFailure = failureDetail({
          status,
          code: kind,
          kind,
          message: res.error?.message ?? "",
          upstream: respBody,
          stage: "upstream_response",
        });
        attemptDetails.push({
          attempt: attemptCount,
          uid: acct.uid,
          status,
          ok: false,
          errKind: kind,
          durationMs: Math.max(1, Date.now() - attemptStarted),
          ttfbMs: 0,
          error: attemptFailure,
        });

        // 6020 队列等待：模型级短冷却后立即返回 429，不换号不退避。
        // 继续轮转只会把一次排队放大成 max_rotate 次上游请求；落到末端还会
        // 被误报成 503 no_healthy_account。Retry-After 给客户端明确等待口径。
        if (kind === "soft_queue") {
          const retryMs = res.error?.retryAfterMs && res.error.retryAfterMs > 0
            ? res.error.retryAfterMs
            : cfg.soft_cooldown_ms;
          const effectiveMs = Math.min(cfg.soft_cooldown_ms, retryMs);
          await pool.applyErrorKind(cfg, acct.uid, kind, respBody, bare, retryMs);
          fail(acct.uid);
          finishLog(429, acct.uid, kind, undefined, attemptFailure);
          return openAIError(
            429,
            "upstream_queueing",
            respBody.trim() || "upstream is queueing this request; retry shortly",
            hintOf(kind, respBody),
            { "Retry-After": String(Math.max(1, Math.ceil(effectiveMs / 1000))) },
          );
        }

        // 内容拦截误报（passthrough/append 首遇）→ 触发降级同请求内重试。
        if (
          kind === "content_blocked" &&
          (cfg.prompt_mode === "passthrough" || cfg.prompt_mode === "append") &&
          !degradedApplied
        ) {
          triggerDegrade();
          outBody = rewriteSystemPrompt(JSON.parse(outBody) as Obj, DEGRADED_PROMPT);
          snapshotOutbound(res.preparedBody);
          degradedApplied = true;
          tried.delete(acct.uid); // 单账号池也能拿到重试机会
          releaseHeld();
          continue;
        }
        // 内容命中审核（第二次）→ 400 透传原文，不轮转。
        if (kind === "content_blocked") {
          await pool.applyErrorKind(cfg, acct.uid, kind, respBody, bare, 0);
          fail(acct.uid);
          finishLog(400, acct.uid, kind, undefined, attemptFailure);
          return openAIError(
            400, "content_blocked",
            respBody.trim() || "content blocked by upstream content firewall",
            hintOf(kind, respBody),
          );
        }
        // 请求级确定性错误：透传原文 400，不罚不轮转。
        if (
          kind === "prompt_too_long" ||
          kind === "image_invalid" ||
          kind === "bad_params"
        ) {
          fail(acct.uid);
          finishLog(400, acct.uid, kind, undefined, attemptFailure);
          return openAIError(
            400, kind,
            respBody.trim() || `upstream rejected request (${kind})`,
            hintOf(kind, respBody),
          );
        }
        // 其余分类错误：落账号处置 + 换号。
        lastErr = {
          kind, status, msg: respBody,
          retryAfterMs: res.error?.retryAfterMs ?? 0,
        };
        await pool.applyErrorKind(cfg, acct.uid, kind, respBody, bare, lastErr.retryAfterMs);
        fail(acct.uid);
        // WAF IP 级 fail-fast（优先于轮转退避——IP 级拦截时退避无意义）：
        // 该次 WAF 403 喂入 IP 级状态机，若激活（短窗多号命中，IP 被拦而非账号）
        // 直接终止轮转返回 403，避免把一次客户端请求放大 max_rotate 倍加重风控。
        if (kind === "waf_block" && wafip.noteWaf(acct.uid)) {
          finishLog(403, acct.uid, "waf_ip_blocked", undefined, failureDetail({
            status: 403,
            code: "waf_ip_blocked",
            kind: "waf_block",
            message: "waf ip-level block: upstream firewall is blocking the gateway IP",
            upstream: respBody,
            stage: "upstream_response",
          }));
          return openAIError(
            403, "waf_ip_blocked",
            "waf ip-level block: upstream firewall is blocking the gateway IP, " +
            "rotation stopped; retry after the block window expires",
          );
        }
        await sleep(backoffAfter(i)); // 分类错误换号退避（WAF fail-fast 优先于退避）
        continue;
      }

      // ── 这一跳真成功后的处置（流式 / 非流式） ─────────────────────────
      if (stream && res.body) {
        // 流式：规范化透传 + error 帧旁路采集。
        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
        // 标记修复（Go handler.go:1047 同语义）：restore 上游吐在 content 里的
        // 原生工具调用标记为 delta.tool_calls；第二参 true = 名单为空时弱判定
        // （tools 声明链路丢失是实测最常见的泄漏成因，只做严格判定等于不设防）。
        const statsPromise = streamPassthrough(
          res.body, writable, new MarkupRepair(declaredTools, true),
          (payload) => frameHint(payload, hintContext),
          attemptStarted,
        );
        const uidCaptured = acct.uid;
        // 流式响应的租约归 statsPromise 的完成/中断回调释放；外层 finally 不能
        // 在响应头刚返回时提前释放，否则同一账号可能被并发超额占用。
        heldUID = "";
        void statsPromise.then(async (stats) => {
          const endedAt = Date.now();
          const latencyMs = Math.max(1, endedAt - attemptStarted);
          const kind = stats.errorFrame ? classify(200, stats.errorFrame) : "";
          const frameKind: ErrKind = kind === "" ? "client" : kind;
          const responseMessage = assistantMessageForLog({
            role: stats.assistantRole,
            content: stats.assistantContent,
            reasoningContent: stats.assistantReasoning,
            toolCalls: stats.assistantToolCalls,
          });
          const detail = stats.errorFrame ? failureDetail({
            status: 200,
            code: kind,
            kind,
            message: "上游在 HTTP 200 流中返回错误",
            upstream: stats.errorFrame,
            stage: "upstream_stream",
          }) : "";
          attemptDetails.push({
            attempt: attemptCount,
            uid: uidCaptured,
            status: 200,
            ok: kind === "",
            errKind: kind,
            durationMs: latencyMs,
            ttfbMs: stats.ttfbMs,
            error: detail,
          });
          try {
            if (stats.errorFrame) {
              // 上游 200 已开流 + error 帧：按帧分类处置，不记成功不绑粘性。
              await pool.applyErrorKind(cfg, uidCaptured, frameKind, stats.errorFrame, bare, 0);
              await recordAttempt({
                uid: uidCaptured, model: bare, realm, provider: "",
                ok: false, errKind: frameKind, stats,
                latencyMs, keyName, modelRate,
              });
            } else {
              const tps = stats.hasUsage && stats.completionTokens >= 0
                ? tokensPerSecond(stats.completionTokens, latencyMs, stats.ttfbMs)
                : null;
              if (stats.hasCache) {
                noteCacheTokens(bare, stats.promptTokens, stats.cacheHitTokens, stats.cacheMissTokens);
              }
              await pool.noteSuccess(uidCaptured);
              await pool.blockModelClear(uidCaptured, bare);
              if (sessKey && cfg.session_sticky) await bindSticky(sessKey, uidCaptured);
              await recordAttempt({
                uid: uidCaptured, model: bare, realm, provider: "",
                ok: true, errKind: "", stats,
                latencyMs, tps, keyName, modelRate,
              });
              if (stats.hasCredit && stats.totalTokens > 0) {
                await pool.noteModelCost(uidCaptured, bare, stats.credit, stats.totalTokens);
              }
            }
          } catch (e) {
            runlog("WARN: stream accounting failed: " + errorText(e));
          } finally {
            pool.release(uidCaptured);
            finishLog(
              200,
              uidCaptured,
              kind,
              stats,
              detail,
              responseMessage,
              endedAt - started,
            );
          }
        }, async (rejection) => {
          const endedAt = Date.now();
          const latencyMs = Math.max(1, endedAt - attemptStarted);
          const kind = opts.req?.signal.aborted ? "client_cancelled" : "stream_interrupted";
          const stats = rejection instanceof StreamPassthroughError ? rejection.stats : undefined;
          const detail = failureDetail({
            status: 200,
            code: kind,
            kind,
            message: opts.req?.signal.aborted
              ? "客户端在流式响应结束前断开"
              : "流式响应在结束前中断",
            upstream: errorText(rejection),
            stage: "stream_passthrough",
          });
          const responseMessage = stats ? assistantMessageForLog({
            role: stats.assistantRole,
            content: stats.assistantContent,
            reasoningContent: stats.assistantReasoning,
            toolCalls: stats.assistantToolCalls,
          }) : null;
          attemptDetails.push({
            attempt: attemptCount,
            uid: uidCaptured,
            status: 200,
            ok: false,
            errKind: kind,
            durationMs: latencyMs,
            ttfbMs: stats?.ttfbMs,
            error: detail,
          });
          // 读写中断同样释放租约，且不把客户端取消惩罚为账号错误。
          try {
            await recordAttempt({
              uid: uidCaptured, model: bare, realm, provider: "", ok: false,
              errKind: kind, ...(stats ? { stats } : {}),
              latencyMs, keyName, modelRate,
            });
          } catch (e) {
            runlog("WARN: stream failure accounting failed: " + errorText(e));
          } finally {
            pool.release(uidCaptured);
            finishLog(
              200,
              uidCaptured,
              kind,
              stats,
              detail,
              responseMessage,
              endedAt - started,
            );
          }
        }).catch(() => runlog("WARN: stream accounting failed"));
        return new Response(readable, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      // 非流式：聚合成单个 chat.completion。
      if (!res.body) {
        const detail = failureDetail({
          status: 502,
          code: "upstream_parse",
          kind: "upstream_parse",
          message: "上游响应没有可读取的响应体",
          stage: "upstream_response",
        });
        attemptDetails.push({
          attempt: attemptCount,
          uid: acct.uid,
          status: 502,
          ok: false,
          errKind: "upstream_parse",
          durationMs: Math.max(1, Date.now() - attemptStarted),
          error: detail,
        });
        fail(acct.uid);
        finishLog(502, acct.uid, "upstream_parse", undefined, detail);
        return openAIError(502, "upstream_parse", "empty upstream stream");
      }
      let agg;
      try {
        agg = await aggregate(res.body);
      } catch (e) {
        const detail = failureDetail({
          status: 502,
          code: "upstream_parse",
          kind: "upstream_parse",
          message: e instanceof Error ? e.message : "aggregate failed",
          upstream: errorText(e),
          stage: "response_aggregate",
        });
        attemptDetails.push({
          attempt: attemptCount,
          uid: acct.uid,
          status: 502,
          ok: false,
          errKind: "upstream_parse",
          durationMs: Math.max(1, Date.now() - attemptStarted),
          error: detail,
        });
        fail(acct.uid);
        finishLog(502, acct.uid, "upstream_parse", undefined, detail);
        return openAIError(
          502, "upstream_parse",
          e instanceof Error ? e.message : "aggregate failed",
        );
      }
      const endedAt = Date.now();
      const latencyMs = Math.max(1, endedAt - attemptStarted);
      await pool.noteSuccess(acct.uid);
      await pool.blockModelClear(acct.uid, bare);
      if (sessKey && cfg.session_sticky) await bindSticky(sessKey, acct.uid);
      const tps = agg.stats.hasUsage && agg.stats.completionTokens >= 0
        ? tokensPerSecond(agg.stats.completionTokens, latencyMs, agg.stats.ttfbMs)
        : null;
      if (agg.stats.hasCache) {
        noteCacheTokens(bare, agg.stats.promptTokens, agg.stats.cacheHitTokens, agg.stats.cacheMissTokens);
      }
      await recordAttempt({
        uid: acct.uid, model: bare, realm, provider: "",
        ok: true, errKind: "", stats: agg.stats,
        latencyMs, tps, keyName, modelRate,
      });
      attemptDetails.push({
        attempt: attemptCount,
        uid: acct.uid,
        status: 200,
        ok: true,
        errKind: "",
        durationMs: latencyMs,
        ttfbMs: agg.stats.ttfbMs,
      });
      if (agg.stats.hasCredit && agg.stats.totalTokens > 0) {
        await pool.noteModelCost(acct.uid, bare, agg.stats.credit, agg.stats.totalTokens);
      }
      // 非流式标记修复（Go handler.go:1148 同语义）：content 含原生标记且
      // 无结构化 tool_calls、finish_reason=stop 时，还原为 message.tool_calls。
      // 注意：repairAggregatedResponse 原地修改 resp 并返回状态机本身，
      // 这里必须序列化 resp，不能把返回值当响应体（否则客户端只拿到
      // {allowed, allowUnknown, hold, inBlock, …} 这类内部字段）。
      repairAggregatedResponse(agg.resp as Obj, declaredTools, true);
      const choices = agg.resp["choices"];
      const firstChoice = Array.isArray(choices) && choices[0]
        && typeof choices[0] === "object" ? choices[0] as Obj : null;
      const finalResponse = firstChoice
        ? responseMessageFromObject(firstChoice["message"])
        : null;
      finishLog(200, acct.uid, "", agg.stats, undefined, finalResponse, endedAt - started);
      return Response.json(agg.resp);
    }
  } finally {
    releaseHeld();
  }

  // ── 末端错误透传（与 Go 同口径映射） ────────────────────────────────────
  let status = 503;
  let code = "no_healthy_account";
  let msg = "all accounts are temporarily unavailable, please retry later";
  // gateway_hint：本地调度类错误（无上游原文）固定 no_healthy hint；有上游原文
  // 时按 Kind + 原文 + 请求形态判定（hintOf 统一入口，与 Go 同口径）。
  let hint = noHealthyAccountHint();
  let upstreamMsgPassed = false;
  let modelBlockDetail = "";

  if (lastErr) {
    hint = hintOf(lastErr.kind, lastErr.msg);
    switch (lastErr.kind) {
      case "waf_block":
        if (wafip.active()) {
          // IP 级拦截措辞（fail-fast 终止路径）。
          status = 403;
          code = "waf_ip_blocked";
          msg = "waf ip-level block: upstream firewall is blocking the gateway IP, " +
            "rotation stopped; retry after the block window expires";
          upstreamMsgPassed = true;
        }
        break;
      case "soft_rate":
        status = 429;
        code = "rate_limit_exceeded";
        msg = "rate limited: all accounts are cooling down, please wait a moment and try again";
        break;
      case "soft_queue":
        status = 429;
        code = "upstream_queueing";
        msg = "upstream is queueing this request; retry shortly";
        break;
      case "model_blocked":
        status = 400;
        code = "model_unavailable";
        break;
      default:
        break;
    }
    if (lastErr.msg.trim() && code !== "waf_ip_blocked") {
      msg = lastErr.msg.trim();
      upstreamMsgPassed = true;
    }
  }
  if (modelBlock?.blocked) {
    code = "model_unavailable";
    status = 400;
    if (!upstreamMsgPassed) {
      msg = "model is unavailable on every account (per-model cooldown), try another model";
    }
    // 池级锁定的运营信息并入 gateway_hint（保留既有明细 + 统一 kind 提示）。
    const kindHint = hintOf("model_blocked", lastErr?.msg ?? "");
    let lockDetail = `model_blocked: ${modelBlock.count} account(s) cooling down this model`;
    if (modelBlock.until > 0) {
      lockDetail += "; earliest unblock at " + new Date(modelBlock.until).toISOString();
    }
    if (modelBlock.reason.trim()) lockDetail += "; upstream: " + modelBlock.reason;
    modelBlockDetail = lockDetail;
    hint = kindHint ? kindHint + "; " + lockDetail : lockDetail;
  }
  const finalKind = lastErr?.kind ?? (modelBlock?.blocked ? "model_blocked" : "");
  finishLog(status, "", finalKind, undefined, failureDetail({
    status,
    code,
    kind: finalKind,
    message: msg,
    upstream: lastErr?.msg || modelBlock?.reason || "",
    hint,
    modelBlock: modelBlockDetail,
    stage: attemptCount > 0 ? "rotation_exhausted" : "account_selection",
  }));
  return openAIError(status, code, msg, hint);
}
