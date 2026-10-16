// 面板内嵌 WorkBuddy OAuth 设备授权流程的公共原语（移植 internal/panel/login.go）。
// 无 PKCE（设备流由服务端签发 state）；请求头与上游端点与 Go 保持一致。

export const UPSTREAM_BASE_CN = "https://copilot.tencent.com";
export const UPSTREAM_BASE_GLOBAL = "https://www.workbuddy.ai";
export const LOGIN_UA = "CLI/2.63.2 CodeBuddy/2.63.2";

export interface LoginEndpoints {
  state: string;
  token: string; // 前缀，拼 state 参数
  account: string; // 前缀
  origin: string;
}

export function loginEndpoints(realm: string): LoginEndpoints {
  const base = realm === "global" ? UPSTREAM_BASE_GLOBAL : UPSTREAM_BASE_CN;
  const origin = realm === "global" ? "https://www.workbuddy.ai" : "https://www.codebuddy.cn";
  return {
    state: base + "/v2/plugin/auth/state?platform=CLI",
    token: base + "/v2/plugin/auth/token?state=",
    account: base + "/v2/plugin/login/account?state=",
    origin,
  };
}

// loginDoJSON 发一次 JSON 请求并解 {code,msg,data} 信封（code!=0 视为业务错误）。
export async function loginDoJSON(
  method: string,
  fullURL: string,
  bearer: string,
  body: string | null,
  origin: string,
): Promise<unknown> {
  const resp = await fetch(fullURL, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest",
      Origin: origin,
      Referer: origin + "/",
      "User-Agent": LOGIN_UA,
      ...(bearer ? { Authorization: "Bearer " + bearer } : {}),
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await resp.text();
  if (resp.status >= 300) {
    throw new Error("http_error: upstream " + resp.status);
  }
  let env: { code?: number; msg?: string; data?: unknown };
  try {
    env = JSON.parse(raw) as typeof env;
  } catch (e) {
    throw new Error("parse failed: " + (e instanceof Error ? e.message : String(e)));
  }
  if (env.code !== 0) {
    throw new Error("code=" + env.code + " msg=" + (env.msg ?? ""));
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
