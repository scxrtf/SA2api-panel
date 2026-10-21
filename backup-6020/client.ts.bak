// 上游 HTTP 客户端（移植 internal/upstream/client.go + headers.go）。
// 端点/请求头/信封解析与 Go 版逐字对齐；网络层用全局 fetch（AbortSignal.timeout）。
import { createHash, randomBytes } from "crypto";
import { getConfig, type AppConfig } from "../config";
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

const DEFAULT_CLIENT_VERSION = "5.5.4";
const DEFAULT_CLI_VERSION = "2.137.1";

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

// 会话头族 ID
export function newMessageID(): string {
  return randomBytes(16).toString("hex");
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
  conversationRequestID: string;
  traceID: string;
}

// 请求头构造
function clientVersion(cfg: AppConfig): string {
  return cfg.client_version || DEFAULT_CLIENT_VERSION;
}
function cliVersion(cfg: AppConfig): string {
  return cfg.cli_version || DEFAULT_CLI_VERSION;
}

function userAgent(cfg: AppConfig, a: AuthShape): string {
  if (cfg.user_agent) return cfg.user_agent;
  const platform = isGlobal(a) ? "WorkBuddy AI" : "WorkBuddy";
  return `WorkBuddy/${clientVersion(cfg)} ${platform}/${clientVersion(cfg)} CLI/${cliVersion(cfg)}`;
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

function injectAttribution(h: Record<string, string>, cfg: AppConfig): void {
  const name = attributionClientName(cfg);
  if (name === "SaaS") {
    h["X-Product"] = "SaaS";
    return;
  }
  h["X-Agent-Purpose"] = "conversation";
  h["X-IDE-Name"] = name;
  h["X-IDE-Type"] = name;
  h["X-IDE-Version"] = clientVersion(cfg);
  h["X-Product"] = name;
}

function resolveDeviceToken(cfg: AppConfig, a: AuthShape): string {
  return a.deviceToken || cfg.device_token || "";
}

function injectConversationHeaders(h: Record<string, string>, meta: ChatMeta): void {
  let convReqID = meta.conversationRequestID;
  if (!convReqID) convReqID = newMessageID();
  const messageID = newMessageID();
  if (meta.conversationID) h["X-Conversation-ID"] = meta.conversationID;
  h["X-Conversation-Request-ID"] = convReqID;
  h["X-Conversation-Message-ID"] = messageID;
  h["X-Request-ID"] = messageID;
  h["X-Root-Request-ID"] = convReqID;
  h["X-Trace-ID"] = meta.traceID || convReqID;
  const b3Trace = validTraceID(convReqID) ? convReqID : messageID;
  h["X-B3-TraceId"] = b3Trace;
  h["X-B3-SpanId"] = messageID.slice(0, 16);
  h["X-B3-Sampled"] = "1";
}

export function chatHeaders(
  cfg: AppConfig,
  a: AuthShape,
  clientIP: string,
  meta: ChatMeta,
): Record<string, string> {
  const h = commonHeaders(cfg, a);
  h["Accept"] = "application/json, text/event-stream";
  if (a.accessToken) h["Authorization"] = "Bearer " + a.accessToken;
  else h["X-No-Authorization"] = "1";
  if (a.uid) h["X-User-Id"] = a.uid;
  else h["X-No-User-Id"] = "1";
  if (!isGlobal(a)) {
    if (a.enterpriseId) h["X-Enterprise-Id"] = a.enterpriseId;
    else h["X-No-Enterprise-Id"] = "1";
    if (a.domain) h["X-Domain"] = a.domain;
    else h["X-No-Department-Info"] = "1";
  } else {
    // global 个人账号：显式声明无企业 + 国际版域（对齐 intl 客户端）。
    h["X-No-Enterprise-Id"] = "1";
    h["X-Domain"] = "www.workbuddy.ai";
  }
  injectAttribution(h, cfg);
  if (cfg.passthrough_ip && clientIP) {
    h["X-Forwarded-For"] = clientIP;
    h["X-Real-IP"] = clientIP;
    h["X-Client-IP"] = clientIP;
  }
  const dt = resolveDeviceToken(cfg, a);
  if (dt) h["X-Device-Token"] = dt;
  injectConversationHeaders(h, meta);
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
  else if (attributionClientName(cfg) !== "SaaS") h["User-Agent"] = `WorkBuddy/${clientVersion(cfg)}`;
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
    let kind = classify(resp.status, env.msg ?? "");
    if (kind === "none") kind = "client";
    throw new UpstreamError(kind, resp.status, msg);
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

// buildCacheKey 生成 `wb2a-<uid8>-<convHex>` 格式的稳定 cache key（对齐 Go buildCacheKey）：
// uid8 账号隔离段（跨账号绝不碰撞）；convHex = sha256(uid|conversation) 前 16 字节 hex。
function buildCacheKey(uid: string, conversation: string): string {
  let uid8 = uid.length > 8 ? uid.slice(0, 8) : uid;
  if (uid8 === "") uid8 = "-";
  const convHex = createHash("sha256").update(uid + "|" + conversation, "utf8").digest("hex").slice(0, 32);
  return `wb2a-${uid8}-${convHex}`;
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

export interface ChatStreamResult {
  ok: boolean;
  status: number;
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
): Promise<ChatStreamResult> {
  const prepared = prepareBody(body, a.realm, a.uid, meta.conversationID);
  // 首字节（响应头）超时：对齐 Go chat 会话的 transport.ResponseHeaderTimeout
  // （main.go 按 upstream.header_timeout_seconds 注入）。只约束响应头到达前的时长，
  // 头到手就清定时器——SSE 长流的流中静默交给 stream_idle_ms 看门狗，不误杀。
  const headerMs = cfg.header_timeout_ms > 0 ? cfg.header_timeout_ms : 0;
  const headerCtrl = new AbortController();
  const headerTimer = headerMs > 0
    ? setTimeout(() => headerCtrl.abort(new DOMException("upstream header timeout", "TimeoutError")), headerMs)
    : null;
  const sig = signal ? AbortSignal.any([signal, headerCtrl.signal]) : headerCtrl.signal;
  let resp: Response;
  try {
    resp = await fetch(chatBase(a) + CHAT_PATH, {
      method: "POST",
      headers: chatHeaders(cfg, a, clientIP, meta),
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
      return { ok: false, status: resp.status, respBody: raw };
    }
    return {
      ok: false,
      status: resp.status,
      respBody: raw,
      error: new UpstreamError(kind, resp.status, truncate(raw, 200), parseRetryAfter(resp.headers)),
    };
  }
  if (!resp.body) return { ok: false, status: resp.status, respBody: "empty body" };
  // 空闲看门狗（对齐 Go client.go:1079 monitorBody）：静默超 stream_idle_ms 掐流，
  // 防止僵死 SSE 连接占住账号租约；0=禁用。首字节前由 fetch 超时管，这里只管流中。
  return { ok: true, status: resp.status, body: idleMonitorBody(resp.body, cfg.stream_idle_ms) };
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
