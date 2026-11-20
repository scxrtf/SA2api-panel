// WorkBuddy 5.9.3 / CLI 2.165.0 AccountScopedExternalLink 登录请求。
// 证据：.runtime/alignment-login-evidence.json；不读取桌面端登录凭据。
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG, type AppConfig } from "./config";
import { rpcUserAgent, type AuthShape } from "./upstream/client";
import { officialEgress } from "./upstream/official-egress";
import { isJSONObject } from "./request-validation";

export const UPSTREAM_BASE_CN = "https://www.workbuddy.cn";
export const UPSTREAM_BASE_GLOBAL = "https://www.workbuddy.ai";
export const LOGIN_TOKEN_PENDING_CODE = 11217;
export const LOGIN_ACCOUNT_PENDING_CODE = 12151;
const CN_AUTH_ORIGINS = new Set([UPSTREAM_BASE_CN, "https://copilot.tencent.com", "https://wb.tencentbuddy.com"]);

function loginAuthShape(realm: string): AuthShape {
  return { uid: "", nickname: "", realm, accessToken: "", refreshToken: "", expiresAt: 0,
    domain: "", enterpriseId: "", deviceToken: "" };
}

// 保留导出兼容性；实际请求按 realm 和当前配置构造 UA。
// 保持纯常量，避免仅导入 validUID/authShapeOf 时触发跨模块 UA 初始化。
export const LOGIN_UA = "WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0";

export interface LoginEndpoints {
  state: string;
  token: string; // 前缀，拼 state 参数
  account: string; // AccountScoped 直接以 Bearer 取 /account，不拼 state
  origin: string;
}

export function loginEndpoints(realm: string): LoginEndpoints {
  const base = realm === "global" ? UPSTREAM_BASE_GLOBAL : UPSTREAM_BASE_CN;
  return {
    state: base + "/v2/plugin/auth/state?platform=workbuddy",
    token: base + "/v2/plugin/auth/token?state=",
    account: base + "/v2/plugin/account",
    origin: base,
  };
}

// 与原生 alignLoginPageUrl 相同：仅在三个受信 CN API origin 之间重定向登录页。
export function alignLoginAuthURL(authURL: string, apiOrigin: string): string {
  if (!CN_AUTH_ORIGINS.has(apiOrigin)) return authURL;
  try {
    const url = new URL(authURL);
    const target = new URL(apiOrigin);
    const trustedHost = [...CN_AUTH_ORIGINS].some((origin) => new URL(origin).hostname === url.hostname);
    if (!trustedHost || url.host === target.host) return authURL;
    url.protocol = target.protocol;
    url.host = target.host;
    return url.toString();
  } catch { return authURL; }
}

export interface LoginRequestContext {
  /** /account 使用 token 返回的 domain；未给时使用选定 API authority。 */
  domain?: string;
  signal?: AbortSignal;
}

export function loginHeaders(
  fullURL: string, bearer: string, body: string | null, origin: string,
  cfg: AppConfig = DEFAULT_CONFIG, context: LoginRequestContext = {},
  method = body === null ? "GET" : "POST",
): Record<string, string> {
  const url = new URL(fullURL);
  const realm = new URL(origin).hostname === new URL(UPSTREAM_BASE_GLOBAL).hostname ? "global" : "cn";
  const publicPhase = url.pathname.endsWith("/auth/state") || url.pathname.endsWith("/auth/token");
  const headers: Record<string, string> = { Accept: "application/json, text/plain, */*" };
  if (body !== null) headers["Content-Type"] = "application/json";
  else if (["POST", "PUT", "PATCH"].includes(method.toUpperCase())) {
    // Axios dispatchRequest 的无显式 Content-Type / 无载荷写方法默认值。
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  if (url.pathname.endsWith("/auth/state") || url.pathname.endsWith("/account")) {
    headers["X-Domain"] = context.domain || new URL(origin).host;
  }
  if (publicPhase) {
    headers["X-No-Authorization"] = "true";
    headers["X-No-User-Id"] = "true";
    headers["X-No-Enterprise-Id"] = "true";
    headers["X-No-Department-Info"] = "true";
  }
  // CommonHeaderHttpInterceptor：无现存 trace/request context 时使用 UUIDv4。
  headers["User-Agent"] = rpcUserAgent(cfg, loginAuthShape(realm));
  headers["X-Request-ID"] = randomUUID().replace(/-/g, "");
  headers["X-Product"] = "SaaS";
  if (bearer && !publicPhase) headers.Authorization = "Bearer " + bearer;
  headers["Accept-Encoding"] = "gzip, compress, deflate, br";
  return headers;
}

export class LoginUpstreamError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number) {
    super(message);
    this.name = "LoginUpstreamError";
  }
}

// loginDoJSON 发一次 JSON 请求并解 {code,msg,data} 信封（code!=0 视为业务错误）。
export async function loginDoJSON(
  method: string,
  fullURL: string,
  bearer: string,
  body: string | null,
  origin: string,
  cfg: AppConfig = DEFAULT_CONFIG,
  context: LoginRequestContext = {},
): Promise<unknown> {
  const timeout = AbortSignal.timeout(30_000);
  // Node/Axios 为无载荷 POST 写出 Content-Length:0；原始出口需显式空字串。
  const wireBody = body === null && method.toUpperCase() === "POST" ? "" : body;
  const resp = await officialEgress(fullURL, {
    method,
    headers: loginHeaders(fullURL, bearer, body, origin, cfg, context, method),
    ...(wireBody !== null ? { body: wireBody } : {}),
    signal: context.signal ? AbortSignal.any([context.signal, timeout]) : timeout,
  });
  const raw = await resp.text();
  if (resp.status >= 300) {
    let code: number | undefined;
    try { const value: unknown = JSON.parse(raw); if (isJSONObject(value) && typeof value.code === "number") code = value.code; } catch { /* non-JSON HTTP error */ }
    throw new LoginUpstreamError("http_error: upstream " + resp.status, resp.status, code);
  }
  let env: { code?: number; msg?: string; data?: unknown };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isJSONObject(parsed)) throw new Error("expected JSON object");
    env = parsed as typeof env;
  } catch (e) {
    throw new Error("parse failed: " + (e instanceof Error ? e.message : String(e)));
  }
  if (env.code !== 0) {
    throw new LoginUpstreamError("code=" + env.code + " msg=" + (env.msg ?? ""), resp.status, env.code);
  }
  return env.data;
}

// validUID 只放行字母/数字/下划线/连字符（≤64），拒绝路径字符与空串。
export function validUID(uid: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(uid);
}

// authShapeOf Account 行 → AuthShape（面板账号操作与 cron 共用的转换）。
export interface AccountLike {
  uid: string;
  nickname: string;
  realm: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: bigint | number;
  domain: string;
  enterpriseId: string;
  deviceToken: string;
}

export function authShapeOf(a: AccountLike) {
  return {
    uid: a.uid,
    nickname: a.nickname,
    realm: a.realm,
    accessToken: a.accessToken,
    refreshToken: a.refreshToken,
    expiresAt: Number(a.expiresAt),
    domain: a.domain,
    enterpriseId: a.enterpriseId,
    deviceToken: a.deviceToken,
  };
}
