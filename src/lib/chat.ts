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
  resolveSticky,
  bindSticky,
  unbindSticky,
} from "./session";
import {
  chatStream,
  refreshToken,
  requestIDForKey,
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
import { streamPassthrough, aggregate, type StreamStats } from "./upstream/sse";
import { tokensPerSecond } from "./upstream/usage";
import { currentModelRate } from "./upstream/modelCatalog";
import { toolNameAllowlist, MarkupRepair, repairAggregatedResponse } from "./upstream/dsml";
import { runlog } from "./runlog";
import { clipLogText } from "./logfmt";
import * as wafip from "./wafip";
import { backoffAfter, sleep } from "./backoff";
import { identifyKeyIdentity, providerAllowed } from "./auth-guard";
import { withFreshAuth, classifySessionError } from "./accountSession";
import { isModelRateLimit } from "./upstream/errors";
import { aggregateStarved, starvedRetryBody } from "./starved";

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
  // 报错内容：失败请求的上游响应正文（已 clipLogText）。成功请求留空。
  errMsg?: string;
}): Promise<void> {
  try {
    await prisma.requestLog.create({ data: r });
  } catch {
    // 同上。
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
    // 供应商准入：子密钥只放行授权名单内的供应商；显式 "*" = 全部；未授权任何
    // 供应商（空）一律拒绝（新建密钥默认态）。身份缺失（无法识别 / DB 异常）
    // 同样按拒绝处理，避免借空授权绕过。
    if (opts.req) {
      const allowed = keyIdentity
        ? keyIdentity.unrestricted || providerAllowed(keyIdentity.providers, provider)
        : false;
      if (!allowed) {
        await recordRequestLog({
          uid: "", model: rawModel, realm: "provider:" + provider, provider,
          status: 403, errKind: "provider_not_authorized", stream,
          errMsg: "key 未授权使用供应商 " + provider,
          durationMs: Date.now() - started, clientIp: clientIP, ua, path, keyName,
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
    stickyUID = (await resolveSticky(sessKey, bare)) ?? "";
  }

  // 会话头族（issue #35）：轮转循环外生成一次，循环内复用。
  const chatMeta: ChatMeta = {
    conversationID: resolveConversationID(body),
    conversationRequestID: "",
    traceID: opts.inboundHeaders.get("x-trace-id") ?? "",
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

  // 模型降级（config.model_fallback，移植上游 2cd2f3d）：curModel 是**本轮实际使用**
  // 的模型，初值 = 客户端请求的 bare。某账号在 curModel 上撞 6004 模型级限流且配了
  // 等价模型时，同账号换模型重试（换模型比换号代价小）。
  //
  // ⚠️ 与 bare 分开的原因：降级后二者指向不同模型，而要喂给不同用途——
  //   - 实际用途（选号 / 出站 body / 成功清理负缓存）→ curModel
  //   - 冷却记账（applyErrorKind 的 6004 分支）→ bare（**限流的是原模型**；误记成
  //     等价模型会把本来可用的等价模型也冷却掉，降级就白做了）
  let curModel = bare;
  // fallbackTried 记录本请求已试过的降级目标，防 A→B→A 循环（与按账号去重的 tried 正交）。
  const fallbackTried = new Set<string>();
  const fallbackTo = (): string => {
    const m = cfg.model_fallback ?? {};
    const to = m[curModel] || (realm ? m[realm + ":" + curModel] ?? "" : "");
    if (!to || to === curModel || fallbackTried.has(to)) return "";
    return to;
  };
  const applyFallback = (to: string): boolean => {
    if (!to) return false;
    fallbackTried.add(to);
    curModel = to;
    // 出站 body 重写：上游必须收到等价模型名（解析失败则不动 body，后续按原样失败）。
    try {
      const o = JSON.parse(outBody) as Obj;
      o["model"] = to;
      outBody = JSON.stringify(o);
    } catch {
      // 坏 body：不二次错误化
    }
    return true;
  };

  const tried = new Set<string>();
  let lastErr: { kind: ErrKind; status: number; msg: string; retryAfterMs: number } | null = null;
  let modelBlock: pool.ModelBlockStatus | null = null;
  let retryAfterMs = 0;
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
  // finishLog 落一条请求日志 + 一行运行日志。errMsg 为失败请求的报错内容
  // （上游正文，已 clip）；缺省空串——成功路径不写，日志表不带噪声。
  const finishLog = (
    status: number,
    uid: string,
    errKind: string,
    extra?: Partial<StreamStats>,
    errMsg = "",
  ) => {
    const errText = errMsg ? clipLogText(errMsg, 1000) : "";
    runlog(
      "chat " + (status < 400 ? "OK " : "ERR ") + status + " " + bare +
      (uid ? " uid=" + uid : "") + (errKind ? " kind=" + errKind : "") +
      " " + (Date.now() - started) + "ms" +
      // 运行日志只带截断片段：完整报错内容看请求日志展开区。
      (errText ? " err=" + clipLogText(errText, 180) : ""),
    );
    void recordRequestLog({
      uid, model: rawModel, realm, provider: "",
      status, errKind, stream,
      errMsg: errText,
      durationMs: Date.now() - started,
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
    });
  };

  let logAttemptStarted = started;
  try {
    for (let i = 0; i < cfg.max_rotate; i++) {
      // 选号：粘性优先，否则普通轮换。
      let entry: pool.PoolEntry | null = null;
      if (stickyUID) {
        entry = await pool.pickByUIDForModel(cfg, stickyUID, curModel);
        if (!entry || (realm !== "" && entry.account.realm !== realm)) {
          void unbindSticky(sessKey);
          stickyUID = "";
          entry = null;
        }
      }
      if (!entry) {
        entry = await pool.pick(cfg, { tried, model: curModel, realm });
      }
      if (!entry) {
        // 全池该模型都处于 6004 冷却时 pick 直接返回 null——若只在上游返回 6004 后
        // 降级，这里会先报 503、根本走不到降级，恰好在最需要降级的场景失效。
        // 故「选不到号」时也尝试换模型，然后重新进入下一轮选号。
        const to = fallbackTo();
        if (to && applyFallback(to)) {
          runlog("model fallback: " + bare + " -> " + to + " (no account for model, 6004 blocked)");
          continue;
        }
        modelBlock = await pool.modelBlocked(curModel, realm);
        const unavailable = await pool.retryStatus(curModel, realm);
        retryAfterMs = unavailable.retryAfterMs;
        // 模型级全冷却使用既有 model_unavailable 语义；仅账号级冷却是 429。
        if (unavailable.accountCooling > 0 && modelBlock) modelBlock.blocked = false;
        if (!lastErr && unavailable.accountCooling > 0) {
          lastErr = {
            kind: "soft_rate", status: 429,
            msg: "all candidate accounts are cooling down", retryAfterMs,
          };
        }
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
        if (isTimeout) {
          lastErr = { kind: "none", status: 0, msg: "upstream timeout", retryAfterMs: 0 };
          finishLog(503, acct.uid, "upstream_timeout", undefined,
            "upstream timeout after " + (Date.now() - attemptStarted) + "ms (" +
            (e instanceof Error ? e.name : "timeout") + ")");
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

      // ── 上游 401（auth_expired）：强制刷新 + 同号重试一次 ────────────────
      // expiresAt 是本地时间戳（可能被写成未来值），token 却已被上游提前吊销，
      // needsRefresh 不会触发——不在这里强制刷新，坏号会一直留在池里被反复选中，
      // 每次客户端请求都在一串死号之间轮转（8 次 × 指数退避 ≈ 40s）再报 503。
      // 复用 accountSession.withFreshAuth：单飞刷新 + 401 刷新后重试一次 + 死号负缓存。
      // 刷新成功 → 同号重试（不占轮转预算、不退避）；刷新失败（12153 / 无
      // refreshToken）→ 该号已死，立即禁用并换号。
      if (!res.ok && (res.error?.kind ?? classify(res.status, res.respBody ?? "")) === "auth_expired") {
        try {
          res = await withFreshAuth(cfg, authShape, async (auth) => {
            const r = await chatStream(cfg, auth, outBody, clientIP, chatMeta);
            if (!r.ok && (r.error?.kind === "auth_expired" || r.error?.kind === "session_dead")) {
              throw r.error;
            }
            return r;
          });
          await pool.clearSessionDead(acct.uid);
          runlog("WARN: upstream 401 uid=" + acct.uid + " → token refreshed, retried");
        } catch (e) {
          const emsg = e instanceof Error ? e.message : String(e);
          const authFailed = classifySessionError(e) !== "upstream_error";
          if (authFailed) {
            // token 已不可用且刷新也无效：号已死，立即禁用（不再参与选号）。
            await pool.disable(
              acct.uid,
              "upstream 401 (token rejected); refresh failed: " + emsg.slice(0, 80),
            );
            await recordAttempt({
              uid: acct.uid, model: bare, realm, provider: "",
              ok: false, errKind: "auth_expired",
            });
            lastErr = { kind: "auth_expired", status: 401, msg: emsg, retryAfterMs: 0 };
            fail(acct.uid);
            // 死号已从池中剔除，退避无意义（客户端更快拿到下一跳）。
            continue;
          }
          // 非鉴权失败（重试时网络抖动）：沿用传输层口径换号，不罚号。
          await recordAttempt({
            uid: acct.uid, model: bare, realm, provider: "",
            ok: false, errKind: "transport",
          });
          lastErr = { kind: "none", status: 0, msg: emsg, retryAfterMs: 0 };
          fail(acct.uid);
          await pool.noteFailures(cfg, acct.uid);
          await sleep(backoffAfter(i));
          continue;
        }
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

        // 模型降级：**仅 6004 模型级限流**触发。等价模型是同一底层能力（计价不同），
        // 被限流时同账号改用另一个继续服务，而不是让客户端等冷却结束。
        // 只认 6004：11102（该后端无此模型）换模型也救不了；11101/普通 429/5xx 是
        // 账号级或瞬时问题，换模型无意义。冷却记在 bare（原模型）名下。
        if (kind === "soft_rate" && isModelRateLimit(respBody)) {
          const to = fallbackTo();
          if (to) {
            await pool.applyErrorKind(cfg, acct.uid, kind, respBody, bare,
              res.error?.retryAfterMs ?? 0);
            if (applyFallback(to)) {
              runlog("model fallback: " + bare + " -> " + to + " (6004 model rate limit, uid=" + acct.uid + ")");
              // 同账号重试：降级是「换模型」不是「换号」，把该号从 tried 移除。
              tried.delete(acct.uid);
              releaseHeld();
              continue;
            }
          }
        }

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
          finishLog(429, acct.uid, kind, undefined, respBody);
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
          degradedApplied = true;
          tried.delete(acct.uid); // 单账号池也能拿到重试机会
          releaseHeld();
          continue;
        }
        // 内容命中审核（第二次）→ 400 透传原文，不轮转。
        if (kind === "content_blocked") {
          await pool.applyErrorKind(cfg, acct.uid, kind, respBody, bare, 0);
          fail(acct.uid);
          finishLog(400, acct.uid, kind, undefined, respBody);
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
          finishLog(400, acct.uid, kind, undefined, respBody);
          return openAIError(
            400, kind,
            respBody.trim() || `upstream rejected request (${kind})`,
            hintOf(kind, respBody),
          );
        }
        // 请求级 4xx（400/413/422）：同一 body 换任何一个号结果都一样。继续轮转
        // 只会把一次客户端错误放大成 max_rotate 次上游请求 + 指数退避（8 次约
        // 39.5s），末端还会被错报成 503 no_healthy_account——排障时看不到真因。
        // 直接按上游状态码透传，不罚号、不退避。
        if (kind === "client" && (status === 400 || status === 413 || status === 422)) {
          fail(acct.uid);
          finishLog(status, acct.uid, kind, undefined, respBody);
          return openAIError(
            status,
            "upstream_client_error",
            respBody.trim() || `upstream rejected the request (HTTP ${status})`,
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
          finishLog(403, acct.uid, "waf_ip_blocked", undefined, respBody);
          return openAIError(
            403, "waf_ip_blocked",
            "waf ip-level block: upstream firewall is blocking the gateway IP, " +
            "rotation stopped; retry after the block window expires",
          );
        }
        // 普通 429 已把该账号置为冷却；健康账号切换不需要等待或指数退避。
        // 只有非限流故障保留短退避，避免客户端为每次换号承担数十秒延迟。
        if (kind !== "soft_rate") await sleep(backoffAfter(i));
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
        void statsPromise.then(async (stats) => {
          try {
            if (stats.errorFrame) {
              // 上游 200 已开流 + error 帧：按帧分类处置，不记成功不绑粘性。
              const kind = classify(200, stats.errorFrame);
              await pool.applyErrorKind(cfg, uidCaptured, kind, stats.errorFrame, bare, 0);
              await recordAttempt({
                uid: uidCaptured, model: bare, realm, provider: "",
                ok: false, errKind: kind, stats,
                latencyMs: Date.now() - attemptStarted, keyName, modelRate,
              });
            } else {
              const latencyMs = Math.max(1, Date.now() - attemptStarted);
              const tps = stats.hasUsage && stats.completionTokens >= 0
                ? tokensPerSecond(stats.completionTokens, latencyMs, stats.ttfbMs)
                : null;
              if (stats.hasCache) {
                noteCacheTokens(bare, stats.promptTokens, stats.cacheHitTokens, stats.cacheMissTokens);
              }
              await pool.noteSuccess(uidCaptured);
              await pool.blockModelClear(uidCaptured, curModel);
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
          } finally {
            pool.release(uidCaptured);
          }
        }, async () => {
          // 读写中断同样释放租约，且不把客户端取消惩罚为账号错误。
          try {
            await recordAttempt({
              uid: uidCaptured, model: bare, realm, provider: "", ok: false,
              errKind: "stream_interrupted", latencyMs: Date.now() - attemptStarted,
              keyName, modelRate,
            });
          } finally {
            pool.release(uidCaptured);
          }
        }).catch(() => runlog("WARN: stream accounting failed"));
        // RequestLog 的 token/TTFB 维度与 Go 的 defer st.done() 同语义：流式
        // 下等流真正结束、末帧 usage 可得时才落日志（响应本身已可先返回）。
        void statsPromise.then((stats) => finishLog(200, uidCaptured,
          stats.errorFrame ? "upstream_error" : "", stats, stats.errorFrame || ""),
          () => finishLog(200, uidCaptured, "stream_interrupted"))
          .catch(() => runlog("WARN: stream request log failed"));
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
        fail(acct.uid);
        finishLog(502, acct.uid, "upstream_parse", undefined, "empty upstream stream");
        return openAIError(502, "upstream_parse", "empty upstream stream");
      }
      let agg;
      try {
        agg = await aggregate(res.body);
      } catch (e) {
        fail(acct.uid);
        finishLog(502, acct.uid, "upstream_parse", undefined,
          e instanceof Error ? e.message : "aggregate failed");
        return openAIError(
          502, "upstream_parse",
          e instanceof Error ? e.message : "aggregate failed",
        );
      }
      // 空截断救援（上游 b0320cf，见 starved.ts）：预算被思考吃光 → 正文零字节、
      // finish_reason=length。同额度关思考重发一次、重新聚合；失败即按原路降级。
      if (aggregateStarved(agg.resp as Obj)) {
        const retryBody = starvedRetryBody(outBody);
        if (retryBody) {
          const res2 = await chatStream(cfg, authShape, retryBody, clientIP, chatMeta)
            .catch(() => null);
          if (res2?.ok && res2.body) {
            const agg2 = await aggregate(res2.body).catch(() => null);
            if (agg2) {
              agg = agg2;
              runlog("[starved] non-stream uid=" + acct.uid + " model=" + bare +
                ": 预算被思考吃光（正文 0B）→ 同额度关思考重发成功");
            } else {
              runlog("WARN: [starved] non-stream uid=" + acct.uid + " model=" + bare +
                ": 重发聚合失败 → 保留原截断响应");
            }
          } else {
            runlog("WARN: [starved] non-stream uid=" + acct.uid + " model=" + bare +
              ": 关思考重发失败（status=" + (res2?.status ?? 0) + "）→ 保留原截断响应");
          }
        }
      }
      await pool.noteSuccess(acct.uid);
      await pool.blockModelClear(acct.uid, curModel);
      if (sessKey && cfg.session_sticky) await bindSticky(sessKey, acct.uid);
      const latencyMs = Math.max(1, Date.now() - attemptStarted);
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
      if (agg.stats.hasCredit && agg.stats.totalTokens > 0) {
        await pool.noteModelCost(acct.uid, bare, agg.stats.credit, agg.stats.totalTokens);
      }
      finishLog(200, acct.uid, "", agg.stats);
      // 非流式标记修复（Go handler.go:1148 同语义）：content 含原生标记且
      // 无结构化 tool_calls、finish_reason=stop 时，还原为 message.tool_calls。
      // 注意：repairAggregatedResponse 原地修改 resp 并返回状态机本身，
      // 这里必须序列化 resp，不能把返回值当响应体（否则客户端只拿到
      // {allowed, allowUnknown, hold, inBlock, …} 这类内部字段）。
      repairAggregatedResponse(agg.resp as Obj, declaredTools, true);
      return Response.json(agg.resp);
    }
  } finally {
    releaseHeld();
  }

  // ── 末端错误透传（与 Go 同口径映射） ────────────────────────────────────
  // max_rotate 用尽时同样需要反映路由后的真实冷却墙钟：否则所有健康账号已在
  // 请求期间进入冷却，却仍让客户端立即重试。只取当前候选集合，不能用最后一次
  // 上游 Retry-After 覆盖其他账号更早的恢复时间。
  if (lastErr) {
    const unavailable = await pool.retryStatus(curModel, realm);
    retryAfterMs = unavailable.retryAfterMs;
  }
  let status = 503;
  let code = "no_healthy_account";
  let msg = "all accounts are temporarily unavailable, please retry later";
  // gateway_hint：本地调度类错误（无上游原文）固定 no_healthy hint；有上游原文
  // 时按 Kind + 原文 + 请求形态判定（hintOf 统一入口，与 Go 同口径）。
  let hint = noHealthyAccountHint();
  let upstreamMsgPassed = false;

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
      // 上游 4xx / 5xx 一律按上游语义回传：旧口径把未覆盖的类别全部落到
      // 503 no_healthy_account，把「请求本身有问题」「账号 token 失效」
      // 「上游 5xx」混成同一个池不可用信号，客户端与排障都被误导。
      case "client":
        if (lastErr.status >= 400 && lastErr.status < 500) {
          status = lastErr.status;
          code = "upstream_client_error";
        }
        break;
      case "auth_expired":
        status = 503;
        code = "upstream_auth_expired";
        msg = "all candidate accounts were rejected by upstream (401 token invalid); " +
          "re-login is required for the affected accounts";
        break;
      case "account_fault":
        status = 503;
        code = "upstream_account_fault";
        msg = "every candidate account hit an account-level fault at upstream; retry later";
        break;
      case "hard_credit":
        // 上游 402 = 候选号积分耗尽，按计费语义回传（OpenAI 兼容）。
        status = 402;
        code = "insufficient_credit";
        break;
      case "server":
        status = 502;
        code = "upstream_server_error";
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
    hint = kindHint ? kindHint + "; " + lockDetail : lockDetail;
  }
  finishLog(status, "", lastErr?.kind ?? "", undefined, lastErr?.msg ?? "");
  const headers = status === 429 && retryAfterMs > 0
    ? { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) }
    : undefined;
  return openAIError(status, code, msg, hint, headers);
}
