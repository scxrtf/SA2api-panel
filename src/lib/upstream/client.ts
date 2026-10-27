// 上游 HTTP 客户端（移植 internal/upstream/client.go + headers.go）。
// 端点/请求头/信封解析与 Go 版逐字对齐；网络层用全局 fetch（AbortSignal.timeout）。
import { createHash, randomBytes, randomUUID } from "crypto";
import { type AppConfig } from "../config";
import { classify, parseRetryAfter, UpstreamError } from "./errors";
import { idleMonitorBody } from "./idle";
import { prepareBodyOpt, ensureConsoleSystem, globalEffortMap, realmKey } from "./payload";
import { effortsSnapshot as catalogEffortsSnapshot } from "./modelCatalog";

// 端点常量（realm 感知）
export const CHAT_BASE_CN = "https://copilot.tencent.com";
export const BILLING_BASE_CN = "https://www.codebuddy.cn";
export const GLOBAL_BASE = "https://www.workbuddy.ai";
export const WEB_BASE_CN = "https://www.workbuddy.cn";

// webBase Web 域基址（global 回落国际版，其余 CN）。
export function webBaseOf(a: AuthShape): string {
  return isGlobal(a) ? GLOBAL_BASE : WEB_BASE_CN;
}

const CHAT_PATH = "/v2/chat/completions";
const REFRESH_PATH = "/v2/plugin/auth/token/refresh";
// billing/meter 域：global 首选无 /v2，404 时 fallback 有 /v2；cn 恒有 /v2。
const METER_PATH = "/billing/meter/get-user-resource";
const METER_PATH_V2 = "/v2/billing/meter/get-user-resource";
const CHECKIN_PATH = "/billing/meter/daily-checkin";
const CHECKIN_PATH_V2 = "/v2/billing/meter/daily-checkin";

const DEFAULT_CLIENT_VERSION_CN = "5.8.3";
const DEFAULT_CLIENT_VERSION_GLOBAL = "5.8.4";
const DEFAULT_CLI_VERSION = "2.161.0";
const BILLING_USER_AGENT = "axios/1.16.1";

// AuthShape 账号凭证快照（DB Account 行的最小投影）。
export interface AuthShape {
  uid: string;
  nickname: string;
  realm: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix 秒
  domain: string;
  enterpriseId: string;
  deviceToken: string;
}

export const isGlobal = (a: AuthShape) => a.realm === "global";

export function chatBase(a: AuthShape): string {
  return isGlobal(a) ? GLOBAL_BASE : CHAT_BASE_CN;
}
export function billingBase(a: AuthShape): string {
  return isGlobal(a) ? GLOBAL_BASE : BILLING_BASE_CN;
}
export function originReferer(a: AuthShape): string {
  return isGlobal(a) ? "https://www.workbuddy.ai" : "https://www.codebuddy.cn";
}
function acceptLanguage(a: AuthShape): string {
  return isGlobal(a) ? "en-US" : "zh-CN";
}

// needsRefresh：token 临近过期（提前 skew 秒）。
export function needsRefresh(a: AuthShape, skewSec: number): boolean {
  if (!a.refreshToken) return false;
  if (a.expiresAt <= 0) return true;
  return Date.now() / 1000 + skewSec >= a.expiresAt;
}

// 会话头族 ID（形态对齐上游 issue #51 真机取证，见上游 internal/session/ids.go）：
// - newMessageID：32 hex，前 12 hex 为毫秒时间戳（官方 X-Request-ID /
//   X-Conversation-Message-ID 前 48 bit 是毫秒时间、同会话严格单调；纯随机构成
//   可聚类批次特征）。
// - newConversationID：UUID v4 带横线 36 字符（官方 X-Conversation-ID 形态），
//   只给网关自建会话用；真实用户会话必须透传客户端声明的 conversationId。
// - newTraceID / newSpanID：纯随机（官方 X-Trace-ID / X-B3-SpanId 与 request id 无关）。
export function newMessageID(): string {
  return Date.now().toString(16).padStart(12, "0") + randomBytes(10).toString("hex");
}

export function newConversationID(): string {
  return randomUUID();
}

export function newTraceID(): string {
  return randomBytes(16).toString("hex");
}

export function newSpanID(): string {
  return randomBytes(8).toString("hex");
}

// 进程启动随机盐：派生 ID 无法按外部可控键内容预计算；重启换新。
const deriveSalt = newMessageID();

export function requestIDForKey(key: string): string {
  if (!key) return newMessageID();
  return createHash("sha256").update(deriveSalt + "|" + key, "utf8").digest("hex").slice(0, 32);
}

export const turnRequestID = requestIDForKey;

// 按 uid 稳定派生 36 hex 设备/会话标识（跨重启恒定，与 Go deriveAccountStableID 同盐）。
function deriveAccountStableID(uid: string, purpose: string): string {
  return createHash("sha256").update(`wb2a:${purpose}:${uid}`, "utf8").digest("hex").slice(0, 36);
}

function validTraceID(s: string): boolean {
  return /^[0-9a-fA-F]{16}$/.test(s) || /^[0-9a-fA-F]{32}$/.test(s);
}

export interface ChatMeta {
  conversationID: string;
  cacheKeyID: string;
  conversationRequestID: string;
  traceID: string;
}

// 请求头构造
function clientVersion(cfg: AppConfig, a: AuthShape): string {
  if (cfg.client_version) return cfg.client_version;
  return isGlobal(a) ? DEFAULT_CLIENT_VERSION_GLOBAL : DEFAULT_CLIENT_VERSION_CN;
}
function cliVersion(cfg: AppConfig): string {
  return cfg.cli_version || DEFAULT_CLI_VERSION;
}

function userAgent(cfg: AppConfig, a: AuthShape): string {
  if (cfg.user_agent) return cfg.user_agent;
  const version = clientVersion(cfg, a);
  const brand = isGlobal(a) ? "workbuddy-ai" : "WorkBuddy";
  return `WorkBuddy/${version} ${brand}/${version} CLI/${cliVersion(cfg)}`;
}

export function commonHeaders(cfg: AppConfig, a: AuthShape): Record<string, string> {
  const origin = originReferer(a);
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Origin: origin,
    Referer: origin + "/",
    "User-Agent": userAgent(cfg, a),
    "X-CodeBuddy-Request": "1",
    "Accept-Language": acceptLanguage(a),
  };
  if (a.uid) {
    h["X-Machine-ID"] = deriveAccountStableID(a.uid, "machine");
    h["X-Session-ID"] = deriveAccountStableID(a.uid, "session");
  }
  return h;
}

function attributionClientName(cfg: AppConfig): string {
  return cfg.client_name || "WorkBuddy";
}

// injectAttribution 注入用量归属头。X-Product 恒为 "SaaS"（上游 issue #51 真机纠正：
// 官方出站 X-Product 是 SKU 段，产品名只在 X-IDE-Name/Type/Version）。
function injectAttribution(h: Record<string, string>, cfg: AppConfig, a: AuthShape): void {
  const name = attributionClientName(cfg);
  h["X-Product"] = "SaaS";
  if (name === "SaaS") {
    return;
  }
  h["X-Agent-Purpose"] = "conversation";
  h["X-IDE-Name"] = name;
  h["X-IDE-Type"] = name;
  h["X-IDE-Version"] = clientVersion(cfg, a);
}

function resolveDeviceToken(cfg: AppConfig, a: AuthShape): string {
  return a.deviceToken || cfg.device_token || "";
}

function cacheKeySource(meta: ChatMeta): string {
  return meta.conversationID || meta.cacheKeyID;
}

// buildStableUUID 由 (uid, conversation, purpose) 稳定派生 UUID v4 形态的 36 字符值。
// purpose 是域分隔段：同一 (账号,会话) 需要多个稳定标识（如会话 ID 与 acp-connection-id）
// 时用它区分；purpose="" 时与旧 buildCacheKey 哈希输入逐字节一致，缓存槽零漂移。
function buildStableUUID(uid: string, conversation: string, purpose = ""): string {
  let input = uid + "|" + conversation;
  if (purpose) input += "|" + purpose;
  const bytes = Buffer.from(createHash("sha256").update(input, "utf8").digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function injectConversationHeaders(h: Record<string, string>, uid: string, meta: ChatMeta): void {
  let convReqID = meta.conversationRequestID;
  if (!convReqID) convReqID = newMessageID();
  const messageID = newMessageID();
  if (meta.conversationID) h["X-Conversation-ID"] = meta.conversationID;
  else if (cacheKeySource(meta)) h["X-Conversation-ID"] = buildStableUUID(uid, cacheKeySource(meta));
  else h["X-Conversation-ID"] = newMessageID();
  h["X-Conversation-Request-ID"] = convReqID;
  h["X-Conversation-Message-ID"] = messageID;
  h["X-Request-ID"] = messageID;
  h["X-Root-Request-ID"] = convReqID;
  // X-Trace-ID 与 request id 互不回落（上游 issue #51 真机实测两族恒不相等）；
  // 入站透传值优先，否则独立随机。
  const traceID = meta.traceID || newTraceID();
  h["X-Trace-ID"] = traceID;
  // B3 跟随 trace（官方 X-B3-TraceId == X-Trace-ID）；透传值非法时回落恒 32 hex 的消息级 ID。
  const b3Trace = validTraceID(traceID) ? traceID : messageID;
  h["X-B3-TraceId"] = b3Trace;
  // SpanId / ParentSpanId 独立随机（官方 span 与 trace/request 均无关系；
  // 不能切片 messageID——那会带出 12 hex 时间前缀）。
  const spanID = newSpanID();
  const parentSpanID = newSpanID();
  h["X-B3-SpanId"] = spanID;
  h["X-B3-ParentSpanId"] = parentSpanID;
  h["X-B3-Sampled"] = "1";
  // B3 单头与 W3C traceparent：官方两版都双发，客户端从不只发 X-B3-* 三件套。
  h["b3"] = `${b3Trace}-${spanID}-1-${parentSpanID}`;
  h["traceparent"] = `00-${b3Trace}-${spanID}-01`;
  // acp-connection-id：官方与 X-Conversation-ID 同批设置（会话注册表 acpConnectionId，
  // 每 session 一次、同会话稳定、与会话 ID 不同值）。按「同 (账号,会话) 稳定」派生。
  h["acp-connection-id"] = cacheKeySource(meta)
    ? buildStableUUID(uid, cacheKeySource(meta), "acp")
    : newConversationID();
}

function injectClientSDKHeaders(h: Record<string, string>): void {
  h["X-Agent-Type"] = "main";
  h["X-Agent-Intent"] = "craft";
  h["X-Stainless-Lang"] = "js";
  h["X-Stainless-Package-Version"] = "6.25.0";
  h["X-Stainless-OS"] = "Windows";
  h["X-Stainless-Arch"] = "x64";
  h["X-Stainless-Runtime"] = "node";
  h["X-Stainless-Runtime-Version"] = "v22.21.1";
  h["X-Stainless-Retry-Count"] = "0";
}

function injectIdentityHeaders(h: Record<string, string>, a: AuthShape): void {
  // issue #51：个人号即使 token 带 token_source（如 login.sh 设备流的 enterprise_switch）
  // 也不发 X-Auth-Method / X-Userinfo——两版真机个人号都不带这两个头；判定只看 enterpriseId。
  if (!a.uid || !a.enterpriseId) return;
  h["X-Userinfo"] = Buffer.from(
    JSON.stringify({ uin: a.uid, owner_uin: a.enterpriseId }),
    "utf8",
  ).toString("base64");
}

export function chatHeaders(
  cfg: AppConfig,
  a: AuthShape,
  clientIP: string,
  meta: ChatMeta,
): Record<string, string> {
  const h = commonHeaders(cfg, a);
  // chat 出站头剥离（上游 issue #51 两版真机逐头对照）：Origin/Referer/Accept-Language
  // 是浏览器语义头，桌面端 chat 从不发；X-Machine-ID/X-Session-ID 是网关自造派生值。
  // 保留在 commonHeaders 里是为了不动 billing/checkin 等域（那层没有真机对照证据）。
  delete h["Origin"];
  delete h["Referer"];
  delete h["Accept-Language"];
  delete h["X-Machine-ID"];
  delete h["X-Session-ID"];
  // Accept 与官方 chat 完全一致：只发 application/json（SSE 照常返回）。
  // Accept-Encoding 刻意不设：显式设置会关闭 fetch 的透明解压，收到 br 时无解码器。
  h["Accept"] = "application/json";
  if (a.accessToken) h["Authorization"] = "Bearer " + a.accessToken;
  else h["X-No-Authorization"] = "1";
  if (a.uid) h["X-User-Id"] = a.uid;
  else h["X-No-User-Id"] = "1";
  // 企业/域头只发有值的：桌面端个人号实测两个方向都不发 X-No-* 哨兵头
  // （那是 CodeBuddy CLI 的约定，不是 WorkBuddy 桌面端形态）。
  if (!isGlobal(a)) {
    if (a.enterpriseId) h["X-Enterprise-Id"] = a.enterpriseId;
    if (a.domain) h["X-Domain"] = a.domain;
  } else {
    // global 个人账号：只声明国际版域（官方个人号同样不发 X-No-Enterprise-Id）。
    h["X-Domain"] = "www.workbuddy.ai";
  }
  injectAttribution(h, cfg, a);
  h["X-Private-Data"] = "true";
  injectIdentityHeaders(h, a);
  if (cfg.passthrough_ip && clientIP) {
    h["X-Forwarded-For"] = clientIP;
    h["X-Real-IP"] = clientIP;
    h["X-Client-IP"] = clientIP;
  }
  const dt = resolveDeviceToken(cfg, a);
  if (dt) h["X-Device-Token"] = dt;
  injectConversationHeaders(h, a.uid, meta);
  // SDK / agent 段指纹头（x-stainless-* / x-agent-type / x-agent-intent），仅 chat 路径。
  injectClientSDKHeaders(h);
  return h;
}

export function billingHeaders(cfg: AppConfig, a: AuthShape): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: "Bearer " + a.accessToken,
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-CodeBuddy-Request": "1",
    "Accept-Language": acceptLanguage(a),
  };
  if (cfg.user_agent) h["User-Agent"] = cfg.user_agent;
  else if (attributionClientName(cfg) !== "SaaS") h["User-Agent"] = BILLING_USER_AGENT;
  if (a.uid) h["X-User-Id"] = a.uid;
  if (a.enterpriseId) {
    h["X-Enterprise-Id"] = a.enterpriseId;
    h["X-Tenant-Id"] = a.enterpriseId;
  }
  if (a.domain) h["X-Domain"] = a.domain;
  const dt = resolveDeviceToken(cfg, a);
  if (dt) h["X-Device-Token"] = dt;
  return h;
}

export function refreshHeaders(cfg: AppConfig, a: AuthShape): Record<string, string> {
  const h = commonHeaders(cfg, a);
  h["X-Refresh-Token"] = a.refreshToken;
  if (a.enterpriseId) h["X-Enterprise-Id"] = a.enterpriseId;
  h["X-Auth-Refresh-Source"] = "plugin";
  return h;
}

// 信封与底层请求
const REFRESH_IO_TIMEOUT_MS = 30_000;
const REFRESH_EXPIRES_IN_MAX_SEC = 10 * 365 * 24 * 3600; // 10 年脏值上限

async function doJSON(req: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}): Promise<unknown> {
  const resp = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    signal: AbortSignal.timeout(req.timeoutMs ?? 60_000),
  });
  const raw = await resp.text();
  if (resp.status >= 400) {
    throw new UpstreamError(classify(resp.status, raw), resp.status, truncate(raw, 200), parseRetryAfter(resp.headers));
  }
  let env: { code?: number; msg?: string; data?: unknown };
  try {
    env = JSON.parse(raw);
  } catch {
    throw new Error(`parse failed: ${truncate(raw, 120)}`);
  }
  if (env.code !== 0 && env.code !== undefined) {
    const msg = `code=${env.code} msg=${truncate(env.msg ?? "", 160)}`;
    // 用完整信封分类：只传 msg 会丢掉业务码（6020 排队 / 11101 / 11115 等）。
    let kind = classify(resp.status, raw);
    if (kind === "none") kind = "client";
    throw new UpstreamError(kind, resp.status, msg, parseRetryAfter(resp.headers));
  }
  return env.data;
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n);
}

// refreshToken 刷新 access token；返回需写回的新字段（由调用方落库）。
export async function refreshToken(
  cfg: AppConfig,
  a: AuthShape,
): Promise<Partial<AuthShape>> {
  if (!a.refreshToken.trim()) throw new Error("no refreshToken");
  const data = (await doJSON({
    url: chatBase(a) + REFRESH_PATH,
    method: "POST",
    headers: refreshHeaders(cfg, a),
    timeoutMs: REFRESH_IO_TIMEOUT_MS,
  })) as { accessToken?: string; refreshToken?: string; expiresIn?: number; domain?: string } | null;
  if (!data?.accessToken) {
    throw new Error("refresh_failed: no accessToken in response — re-login required");
  }
  const out: Partial<AuthShape> = { accessToken: data.accessToken };
  if (data.refreshToken) out.refreshToken = data.refreshToken;
  if (data.domain) out.domain = data.domain;
  // expiresIn 缺省/超量级（脏值）保留旧过期时间，防 NeedsRefresh 永假漂移。
  if (data.expiresIn && data.expiresIn > 0 && data.expiresIn < REFRESH_EXPIRES_IN_MAX_SEC) {
    out.expiresAt = Math.floor(Date.now() / 1000) + data.expiresIn;
  }
  return out;
}

// ---------- 出站请求体组装（对齐 Go client.go prepareBody + cache_key.go） ----------

// efforts 能力缓存（按 realm 分桶）：fetchModels 解析的 supportedEfforts/defaultEffort。
// 对齐 Go Client.efforts/defaultEfforts——远端探测桶在 modelCatalog（fetchModelsFull /
// fetchGlobalModelInfos 成功时权威写入）；global 域无桶时走 globalEffortMap 静态兜底合成
// （issue #84：国际版不发 supportedEfforts 也必须降级）。
type EffortMaps = {
  efforts: Record<string, string[]> | null;
  defs: Record<string, string> | null;
};

// effortsSnapshot 取指定 realm 的 effort 能力表（对齐 Go 语义）：
//   - global → globalEffortMap(远端桶, defs) 合成：静态兜底表为基，远端桶覆盖（权威优先）
//   - cn     → 远端桶原样（无桶 = null，透传不降级；thinking.ts 缺档回退硬编码 high）
function effortsSnapshot(realm: string): EffortMaps {
  const remote = catalogEffortsSnapshot(realm);
  const hasRemote =
    Object.keys(remote.efforts).length > 0 || Object.keys(remote.defaults).length > 0;
  if (realmKey(realm) === "global") {
    const m = globalEffortMap(remote.efforts, remote.defaults);
    return { efforts: m.efforts, defs: m.defs };
  }
  if (hasRemote) return { efforts: remote.efforts, defs: remote.defaults };
  return { efforts: null, defs: null };
}

// sanitizeFingerprints 脱敏开关（对齐 Go Client.SanitizeFingerprints，默认 true）。
// 可用环境变量 WB2A_SANITIZE_FINGERPRINTS=false 关闭（排障用）。
function sanitizeFingerprints(): boolean {
  return process.env.WB2A_SANITIZE_FINGERPRINTS !== "false";
}

// buildCacheKey 生成与官方客户端同形的会话标识：UUID v4 形态的 36 字符
// （上游 issue #51：旧 `wb2a-<uid8>-<convHex>` 自带项目缩写且把 uid 前 8 位明文写进
// X-Conversation-ID 与 prompt_cache_key，三处都可与官方值区分）。
// 语义不变：uid 仍参与哈希输入 → 跨账号绝不碰撞；同 (uid, conversation) 恒得同值。
function buildCacheKey(uid: string, conversation: string): string {
  return buildStableUUID(uid, conversation, "");
}

// injectPromptCacheKey 在已改写的出站 body 上注入 prompt_cache_key（P0 费用优化，
// 对齐 Go InjectPromptCacheKey）。优先级：
//   1. body 已带 prompt_cache_key → 原值保留（客户端自知复用哪个键）
//   2. body 已带 conversation_id / conversationId → 用它做会话哈希源
//   3. 都没有 → 用入站 conversationID 参数（X-Conversation-ID 头解析值）
function injectPromptCacheKey(body: string, uid: string, conversationID: string): string {
  if (!body) return body;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(body);
  } catch {
    return body;
  }
  const existing = obj.prompt_cache_key;
  if (typeof existing === "string" && existing !== "") return body; // 客户端显式带 key，不覆盖
  let conv = conversationID;
  const cid = obj.conversation_id ?? obj.conversationId;
  if (typeof cid === "string" && cid.trim() !== "") conv = cid.trim();
  obj.prompt_cache_key = buildCacheKey(uid, conv);
  try {
    return JSON.stringify(obj);
  } catch {
    return body;
  }
}

// prepareBody 组装出站请求体（对齐 Go client.go:788 prepareBody）：
//   完整改写管线（payload.ts，含 sanitize 开关 + effort 降级 + thinking 注入）
//   → prompt_cache_key 注入
//   → global 域 ensureConsoleSystem 兜底（首条非 system 补 fallback system）。
export function prepareBody(body: string, realm: string, uid: string, conversationID: string): string {
  const { efforts, defs } = effortsSnapshot(realm);
  let out = prepareBodyOpt(body, sanitizeFingerprints(), efforts, defs);
  out = injectPromptCacheKey(out, uid, conversationID);
  if (realmKey(realm) === "global") {
    out = ensureConsoleSystem(out);
  }
  return out;
}

// injectConversationFields 在已改写的出站 body 上补会话轮级字段（上游 issue #51 body 侧，
// 移植 conv_fields.go）：官方桌面端把「这一轮属于哪个 request-id」同时写在头和体里
// （messages[i].conversationRequestId == 出站头 X-Conversation-Request-ID）。
// 边界（不伪造）：
//   - 只给「当前轮」的最后一条 user 消息写；历史轮次 ID 客户端没给，网关无从得知；
//   - 客户端自带该字段时原值优先；空 ID / 坏 body 原样返回。
export function injectConversationFields(body: string, conversationRequestID: string): string {
  if (!body || !conversationRequestID) return body;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(body);
  } catch {
    return body;
  }
  const messages = obj.messages;
  if (!Array.isArray(messages) || messages.length === 0) return body;
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    if (String((message as Record<string, unknown>).role).toLowerCase() === "user") {
      index = i;
      break;
    }
  }
  if (index < 0) return body;
  const current = messages[index] as Record<string, unknown>;
  if (typeof current.conversationRequestId === "string" && current.conversationRequestId !== "") {
    return body;
  }
  current.conversationRequestId = conversationRequestID;
  current.startsNewUserRequest = true;
  if (typeof current.agent !== "string" || current.agent === "") current.agent = "cli";
  messages[index] = current;
  obj.messages = messages;
  try {
    return JSON.stringify(obj);
  } catch {
    return body;
  }
}

export interface ChatStreamResult {
  ok: boolean;
  status: number;
  preparedBody: string;
  body?: ReadableStream<Uint8Array>; // 成功时的 SSE 流
  respBody?: string; // 失败时的原文
  error?: UpstreamError;
}

// chatStream 发 chat 请求。成功返回 SSE body 流；≥400 返回分类错误信封。
export async function chatStream(
  cfg: AppConfig,
  a: AuthShape,
  body: string,
  clientIP: string,
  meta: ChatMeta,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<ChatStreamResult> {
  // 轮级 ID 在头与体之间必须同值（头体一致，issue #51）：入站未给时在这里生成一次，
  // 头部注入与 body 注入共用。
  const convReqID = meta.conversationRequestID || newMessageID();
  const m: ChatMeta = { ...meta, conversationRequestID: convReqID };
  const prepared = injectConversationFields(
    prepareBody(body, a.realm, a.uid, cacheKeySource(m)),
    convReqID,
  );
  // 首字节（响应头）超时：对齐 Go chat 会话的 transport.ResponseHeaderTimeout
  // （main.go 按 upstream.header_timeout_seconds 注入）。只约束响应头到达前的时长，
  // 头到手就清定时器——SSE 长流的流中静默交给 stream_idle_ms 看门狗，不误杀。
  const headerMs = cfg.header_timeout_ms > 0 ? cfg.header_timeout_ms : 0;
  const headerCtrl = new AbortController();
  const headerTimer = headerMs > 0
    ? setTimeout(() => headerCtrl.abort(new DOMException("upstream header timeout", "TimeoutError")), headerMs)
    : null;
  const sig = signal ? AbortSignal.any([signal, headerCtrl.signal]) : headerCtrl.signal;
  const headers = chatHeaders(cfg, a, clientIP, m);
  if (extraHeaders) Object.assign(headers, extraHeaders);
  let resp: Response;
  try {
    resp = await fetch(chatBase(a) + CHAT_PATH, {
      method: "POST",
      headers,
      body: prepared,
      signal: sig,
    });
  } finally {
    if (headerTimer) clearTimeout(headerTimer);
  }
  if (resp.status >= 400) {
    const raw = await resp.text();
    const kind = classify(resp.status, raw);
    if (kind === "none") {
      return { ok: false, status: resp.status, preparedBody: prepared, respBody: raw };
    }
    return {
      ok: false,
      status: resp.status,
      preparedBody: prepared,
      respBody: raw,
      error: new UpstreamError(kind, resp.status, truncate(raw, 200), parseRetryAfter(resp.headers)),
    };
  }
  if (!resp.body) return { ok: false, status: resp.status, preparedBody: prepared, respBody: "empty body" };
  // 空闲看门狗（对齐 Go client.go:1079 monitorBody）：静默超 stream_idle_ms 掐流，
  // 防止僵死 SSE 连接占住账号租约；0=禁用。首字节前由 fetch 超时管，这里只管流中。
  return {
    ok: true,
    status: resp.status,
    preparedBody: prepared,
    body: idleMonitorBody(resp.body, cfg.stream_idle_ms),
  };
}

// billing 域
function meterPaths(a: AuthShape): string[] {
  return isGlobal(a) ? [METER_PATH, METER_PATH_V2] : [METER_PATH_V2];
}
function checkinPaths(a: AuthShape): string[] {
  return isGlobal(a) ? [CHECKIN_PATH, CHECKIN_PATH_V2] : [CHECKIN_PATH_V2];
}

async function billingMeterJSON(
  cfg: AppConfig,
  a: AuthShape,
  paths: string[],
  body: unknown,
): Promise<unknown> {
  let lastErr: unknown;
  for (const p of paths) {
    try {
      return await doJSON({
        url: billingBase(a) + p,
        method: "POST",
        headers: billingHeaders(cfg, a),
        body: JSON.stringify(body ?? {}),
      });
    } catch (e) {
      // global 双路径：404 fallback 到下一条候选。
      if (e instanceof UpstreamError && e.status === 404 && paths.length > 1) {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

interface RespAccount {
  CapacityRemain?: number;
  CapacityUsed?: number;
  CapacitySize?: number;
  CycleCapacityRemain?: number;
  CycleCapacityUsed?: number;
  CycleCapacitySize?: number;
  CycleEndTime?: string;
}

// packageRemainUsed 聚合单套餐 remain/used/size（Cycle 期优先，口径与 Go 一致）。
function packageRemainUsed(a: RespAccount): { remain: number; used: number; size: number } {
  const cRemain = a.CycleCapacityRemain ?? 0;
  const cUsed = a.CycleCapacityUsed ?? 0;
  const cSize = a.CycleCapacitySize ?? 0;
  if (cSize > 0) {
    let remain = cRemain;
    if (remain < 0) remain = 0;
    if (remain > cSize) remain = cSize;
    let used = cSize - remain;
    if (cUsed > used) {
      used = cUsed;
      if (cSize >= used) remain = cSize - used;
    }
    return { remain, used, size: cSize };
  }
  const remain = a.CapacityRemain ?? 0;
  let used = a.CapacityUsed ?? 0;
  const size = a.CapacitySize ?? 0;
  if (used === 0 && size > remain) used = size - remain;
  return { remain, used, size };
}

export interface UserResourceResult {
  remain: number;
  total: number;
  // expiring 是 remain 中在 expiring_soon 窗口内到期的部分（窗口 <=0 时恒 0）。
  expiring: number;
  // earliestAt / earliestRemain：最早未来到期批次的到期时刻（unix 毫秒）与剩余量。
  // 0 表示没有可用的未来到期批次。
  earliestAt: number;
  earliestRemain: number;
}

// expiringSoonMs 把配置的小时窗口转毫秒；<=0 = 禁用快过期分桶（对齐 Go ExpiringSoonDur）。
export function expiringSoonMs(hours: number): number {
  return hours > 0 ? hours * 3_600_000 : 0;
}

// parsePackageEndTime 解析上游套餐到期墙钟时间（UTC+8，格式 "YYYY-MM-DD HH:mm:ss"）。
// 空值/格式异常返回 0——调用方保守地不把该包计入快过期或最早到期（对齐 Go
// parsePackageEndTime）。不能直接 Date.parse 原串：无时区会被按服务器本地时区解释。
function parsePackageEndTime(raw: string | undefined): number {
  if (!raw) return 0;
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(raw.trim());
  if (!m) return 0;
  const ms = Date.parse(m[1] + "T" + m[2] + "+08:00");
  return Number.isFinite(ms) ? ms : 0;
}

const ENTERPRISE_USAGE_PATH = "/v2/billing/meter/get-enterprise-user-usage";
// 企业版「不限量」（上游 limitNum == -1）在池内的等价表示，对齐 Go 常量。
const ENTERPRISE_UNLIMITED_REMAIN = 1 << 40;
const ENTERPRISE_UNLIMITED_TOTAL = -1;

// enterpriseResource 企业版额度（个人资源包体系对 enterpriseId 非空账号恒返回空）。
async function enterpriseResource(
  cfg: AppConfig,
  a: AuthShape,
  soonMs: number,
): Promise<UserResourceResult> {
  const data = (await doJSON({
    url: billingBase(a) + ENTERPRISE_USAGE_PATH,
    method: "POST",
    headers: billingHeaders(cfg, a),
    body: "{}",
  })) as {
    credit?: number;
    limitNum?: number;
    limit_num?: number;
    used_num?: number;
    cycleEndTime?: string;
    cycleResetTime?: string;
  } | null;
  let limit = data?.limitNum ?? 0;
  if (limit === 0 && data?.limit_num) limit = data.limit_num;
  let used = data?.credit ?? 0;
  if (used === 0 && data?.used_num) used = data.used_num;
  if (limit < 0) {
    return {
      remain: ENTERPRISE_UNLIMITED_REMAIN,
      total: ENTERPRISE_UNLIMITED_TOTAL,
      expiring: 0,
      earliestAt: 0,
      earliestRemain: 0,
    };
  }
  let remain = limit - Math.round(used); // credit 是浮点，池内是整数：四舍五入
  if (remain < 0) remain = 0;
  const now = Date.now();
  let end = parsePackageEndTime(data?.cycleEndTime);
  if (end === 0) end = parsePackageEndTime(data?.cycleResetTime);
  if (remain > 0 && end > now) {
    return {
      remain,
      total: limit,
      expiring: soonMs > 0 && end <= now + soonMs ? remain : 0,
      earliestAt: end,
      earliestRemain: remain,
    };
  }
  return { remain, total: limit, expiring: 0, earliestAt: 0, earliestRemain: 0 };
}

// userResource 查询账号积分余额、总额度与到期分布（所有套餐聚合）。
// 对齐 Go UserResourceDetailedWithExpiry：expiring/earliest 供 prefer_expiring 路由。
export async function userResource(
  cfg: AppConfig,
  a: AuthShape,
  soonMs = 0,
): Promise<UserResourceResult> {
  // 企业版额度不在个人资源包体系内：get-user-resource 对企业号恒返回空 Accounts。
  if (a.enterpriseId) return enterpriseResource(cfg, a, soonMs);
  const now = new Date();
  const end = new Date(now.getTime() + 365 * 101 * 24 * 3600_000);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} 00:00:00`;
  const data = (await billingMeterJSON(cfg, a, meterPaths(a), {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: "p_tcaca",
    Status: [0, 3],
    PackageEndTimeRangeBegin: fmt(now),
    PackageEndTimeRangeEnd: fmt(end),
  })) as { Response?: { Data?: { Accounts?: RespAccount[] } } } | null;
  const accounts = data?.Response?.Data?.Accounts ?? [];
  let remain = 0;
  let total = 0;
  let expiring = 0;
  let earliestAt = 0;
  let earliestRemain = 0;
  const nowMs = Date.now();
  for (const acct of accounts) {
    const p = packageRemainUsed(acct);
    let r = p.remain;
    if (r < 0) r = 0;
    let size = p.size;
    if (size < r) size = r;
    remain += r;
    total += size;
    if (r <= 0) continue;
    const endMs = parsePackageEndTime(acct.CycleEndTime);
    // 缺失/无法解析/已过期的包不参与最早批次，也不计入快过期（对齐 Go）。
    if (endMs === 0 || endMs <= nowMs) continue;
    if (earliestAt === 0 || endMs < earliestAt) {
      earliestAt = endMs;
      earliestRemain = r;
    } else if (endMs === earliestAt) {
      earliestRemain += r;
    }
    if (soonMs > 0 && endMs <= nowMs + soonMs) expiring += r;
  }
  return { remain, total, expiring, earliestAt, earliestRemain };
}

export interface CreditPackage {
  name: string;
  remain: number;
  used: number;
  size: number;
  end_time?: string;
  expires_at?: number;
  created_at?: string;
  package_code?: string;
  sub_product_code?: string;
  sub_product_name?: string;
  cycle?: boolean;
}

// creditPackages 返回逐包构成（面板「积分构成」用）。
export async function creditPackages(
  cfg: AppConfig,
  a: AuthShape,
): Promise<{ packages: CreditPackage[]; remain: number; size: number }> {
  const now = new Date();
  const end = new Date(now.getTime() + 365 * 101 * 24 * 3600_000);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} 00:00:00`;
  const data = (await billingMeterJSON(cfg, a, meterPaths(a), {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: "p_tcaca",
    Status: [0, 3],
    PackageEndTimeRangeBegin: fmt(now),
    PackageEndTimeRangeEnd: fmt(end),
  })) as {
    Response?: {
      Data?: {
        Accounts?: (RespAccount & {
          PackageName?: string;
          ExpiredTime?: string;
          PackageEndTime?: string;
          CycleEndTime?: string;
          DeductionEndTime?: number;
          CreateTime?: number;
          PackageCode?: string;
          SubProductCode?: string;
          SubProductName?: string;
        })[];
      };
    };
  } | null;
  const packs = data?.Response?.Data?.Accounts ?? [];
  const out: CreditPackage[] = [];
  let sumRemain = 0;
  let sumSize = 0;
  for (const p of packs) {
    const agg = packageRemainUsed(p);
    const cp: CreditPackage = {
      name: p.PackageName ?? "",
      remain: agg.remain,
      used: agg.used,
      size: agg.size,
      package_code: p.PackageCode || undefined,
      sub_product_code: p.SubProductCode || undefined,
      sub_product_name: p.SubProductName || undefined,
      cycle: (p.CycleCapacitySize ?? 0) > 0 || undefined,
    };
    if (p.DeductionEndTime && p.DeductionEndTime > 0) {
      cp.expires_at = p.DeductionEndTime;
      cp.end_time = new Date(p.DeductionEndTime).toISOString();
    } else {
      const endRaw = p.ExpiredTime || p.PackageEndTime || p.CycleEndTime || "";
      if (endRaw) cp.end_time = endRaw;
    }
    if (p.CreateTime && p.CreateTime > 0) {
      cp.created_at = new Date(p.CreateTime).toISOString();
    }
    sumRemain += cp.remain;
    sumSize += cp.size;
    out.push(cp);
  }
  out.sort((x, y) => y.size - x.size);
  return { packages: out, remain: sumRemain, size: sumSize };
}

// dailyCheckin 每日签到（「已签到」业务错误也抛 UpstreamError，调用方用
// isAlreadyCheckin 区分）。
export async function dailyCheckin(cfg: AppConfig, a: AuthShape): Promise<void> {
  await billingMeterJSON(cfg, a, checkinPaths(a), {});
}

// ─── 账号资料昵称同步（移植 internal/upstream/profile.go） ────────────────
// GET {webBase}/console/account，Bearer + x-client-platform: web（与 tasks 同一
// 鉴权形态）。隐私边界：响应含手机号等敏感字段，本函数只解析 nickname 与
// uid（uid 仅一致性核对），其余字段一概不解析不落日志不透传。
// 只在面板手动「刷新」路径调用，后台余额定时刷新不触发。
export async function fetchAccountProfile(cfg: AppConfig, a: AuthShape): Promise<string> {
  const h: Record<string, string> = {
    Authorization: "Bearer " + a.accessToken,
    Accept: "application/json, text/plain, */*",
    "x-client-platform": "web",
    Origin: "https://www.workbuddy.cn",
    Referer: "https://www.workbuddy.cn/profile/account-settings",
    "User-Agent": userAgent(cfg, a),
  };
  const data = (await doJSON({
    url: webBaseOf(a) + "/console/account",
    method: "GET",
    headers: h,
  })) as { uid?: string; nickname?: string };
  const respUid = data?.uid ?? "";
  if (respUid && a.uid && respUid !== a.uid) {
    throw new Error(`profile uid mismatch: resp=${respUid} auth=${a.uid}`);
  }
  return data?.nickname ?? "";
}

// ─── global trial 加油包（移植 internal/upstream/trial.go） ────────────────
// 仅 global 账号适用（CN 无此端点）；幂等码 14051 = 已领过（视为正常，非错误）。
// 这是 global 唯一天然的积分增益动作（无签到/任务中心）。
const TRIAL_PATH = "/billing/ide/trial";
const trialAlreadyMarkers = ["code=14051", '"code":14051'];

// claimTrial 领取一次性 trial 加油包。仅 global 可调（非 global 直接报错）。
// 返回 claimed：true=成功新领；false=已领过（幂等，不算失败）。
export async function claimTrial(cfg: AppConfig, a: AuthShape): Promise<boolean> {
  if (!isGlobal(a)) throw new Error("claim trial: only global accounts");
  try {
    await doJSON({
      url: billingBase(a) + TRIAL_PATH,
      method: "POST",
      headers: billingHeaders(cfg, a),
      body: JSON.stringify({}),
    });
    return true;
  } catch (e) {
    if (e instanceof UpstreamError && trialAlreadyMarkers.some((m) => e.message.includes(m))) {
      return false; // 已领过：幂等成功，非错误
    }
    throw e;
  }
}

// 模型目录
export interface ModelInfo {
  id: string;
  credits?: string;
}

// fetchModels 拉取账号可用模型目录（面板展示用，失败不阻断主链路）。
export async function fetchModels(cfg: AppConfig, a: AuthShape): Promise<ModelInfo[]> {
  const resp = await fetch(chatBase(a) + "/console/enterprises/personal/models", {
    method: "GET",
    headers: { ...commonHeaders(cfg, a), Authorization: "Bearer " + a.accessToken },
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await resp.text();
  if (resp.status >= 400) {
    throw new UpstreamError(classify(resp.status, raw), resp.status, truncate(raw, 200));
  }
  let env: { code?: number; data?: unknown };
  try {
    env = JSON.parse(raw);
  } catch {
    return [];
  }
  const data = env.data as { models?: { id?: string; modelId?: string; credits?: string }[] } | null;
  const list: { id?: string; modelId?: string; credits?: string }[] =
    data?.models ?? (Array.isArray(data) ? (data as { id?: string }[]) : []);
  return list
    .map((m) => ({ id: m.id ?? m.modelId ?? "", credits: m.credits }))
    .filter((m) => m.id);
}
