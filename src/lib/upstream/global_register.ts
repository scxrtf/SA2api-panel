// global_register.ts 国际版（global realm）新账号注册激活与地区完善
//（移植 internal/upstream/global_register.go）。
//
// 背景：新 global 账号需先完成注册地区（/console/login/account 补地区）再调
// register 接口激活 Trial，chat 才不报 14017 trial not activated。链路：
//
//	POST /billing/area/get-country-code {filterForbidden:1} → 可取国家列表
//	POST /console/login/account {attributes:{countryCode,...}} → 提交地区（幂等）
//	GET  /auth/realms/copilot/overseas/user/register?userId=<uid> → 注册激活
//	  （code:200 成功；code:500 "region required" 需补地区）
//	POST /billing/ide/trial → 一次性加油包（幂等码 14051，见 client.ts claimTrial）
//
// 响应体注意：get-country-code 的 data 是 JSON 字符串（双层信封），需二次解析。
import { GLOBAL_BASE, isGlobal, type AuthShape } from "./client";

// globalWebUA 国际版 web 端 UA（注册完善页走 web 指纹，非桌面端 CLI 指纹）。
const GLOBAL_WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface GlobalCountry {
  EnName?: string; // 英文全名（countryFullName）
  Name?: string; // 显示名
  IOS2?: string; // 二字码（countryName）
  IOS3?: string;
  Code?: string; // 数字码（countryCode）
}

// 注册激活端点的 base（注册链路在 www.workbuddy.ai）。
function globalRegisterBase(): string {
  return GLOBAL_BASE;
}

// globalRegisterJSON 发注册链路请求并解外层信封（code/msg）。
async function globalRegisterJSON(
  method: string,
  url: string,
  token: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ code: number; msg: string; data: unknown }> {
  const base = globalRegisterBase();
  const headers: Record<string, string> = {
    "User-Agent": GLOBAL_WEB_UA,
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    Origin: base,
    Referer: base + "/",
    ...(token ? { Authorization: "Bearer " + token } : {}),
    ...(extraHeaders ?? {}),
  };
  const resp = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const raw = await resp.text();
  let env: { code?: number; msg?: string; data?: unknown };
  try {
    env = JSON.parse(raw) as typeof env;
  } catch {
    throw new Error("global register parse: " + raw.slice(0, 200));
  }
  return { code: env.code ?? -1, msg: env.msg ?? "", data: env.data };
}

// globalFetchCountries 拉取可选注册地区列表（global 账号登录后调用）。
// intlOnly=true 时按国际版 web 白名单过滤（HK/MO/SG/TH/PH/MY/ID，对齐 web 展示集）。
export async function globalFetchCountries(
  a: AuthShape,
  intlOnly: boolean,
): Promise<GlobalCountry[]> {
  if (!isGlobal(a)) throw new Error("fetch countries: only global accounts");
  const { code, msg, data } = await globalRegisterJSON(
    "POST",
    globalRegisterBase() + "/billing/area/get-country-code",
    a.accessToken,
    { filterForbidden: 1 },
  );
  if (code !== 0) throw new Error(`get-country-code: ${msg} (code=${code})`);
  // data 是 JSON 字符串（双层信封）或对象，需二次解析。
  let inner: unknown = data;
  if (typeof inner === "string") {
    try {
      inner = JSON.parse(inner);
    } catch {
      throw new Error("country list unwrap failed");
    }
  }
  const list =
    ((inner as { data?: { list?: GlobalCountry[] } })?.data?.list as GlobalCountry[]) ?? [];
  if (!intlOnly) return list;
  // 国际版 web 白名单过滤（HK, MO, SG, TH, PH, MY, ID，顺序对齐 web 展示）。
  const whitelist = ["HK", "MO", "SG", "TH", "PH", "MY", "ID"];
  const byCode = new Map<string, GlobalCountry>();
  for (const ctry of list) {
    if (ctry.IOS2) byCode.set(ctry.IOS2, ctry);
  }
  const out: GlobalCountry[] = [];
  for (const c of whitelist) {
    const hit = byCode.get(c);
    if (hit) out.push(hit);
  }
  return out;
}

export interface GlobalRegisterStatusResult {
  activated: boolean;
  needsRegion: boolean;
  msg: string;
}

// globalRegisterStatus 报告 global 账号注册激活状态：是否需要补地区、是否已激活。
export async function globalRegisterStatus(a: AuthShape): Promise<GlobalRegisterStatusResult> {
  if (!isGlobal(a)) throw new Error("register status: only global accounts");
  const { code, msg } = await globalRegisterJSON(
    "GET",
    globalRegisterBase() + "/auth/realms/copilot/overseas/user/register?userId=" + a.uid,
    a.accessToken,
    null,
    { "X-User-Id": a.uid },
  );
  if (code === 200) return { activated: true, needsRegion: false, msg: "register success" };
  if (code === 500 || msg.toLowerCase().includes("region required")) {
    return { activated: false, needsRegion: true, msg };
  }
  return { activated: false, needsRegion: false, msg };
}

// globalSubmitRegion 提交注册地区（幂等）。country 来自 globalFetchCountries。
export async function globalSubmitRegion(a: AuthShape, country: GlobalCountry): Promise<void> {
  if (!isGlobal(a)) throw new Error("submit region: only global accounts");
  const attrs = {
    countryCode: [country.Code ?? ""],
    countryFullName: [country.EnName ?? ""],
    countryName: [country.IOS2 ?? ""],
  };
  const { code, msg } = await globalRegisterJSON(
    "POST",
    globalRegisterBase() + "/console/login/account",
    a.accessToken,
    { attributes: attrs },
  );
  if (code !== 0) throw new Error(`submit region: ${msg} (code=${code})`);
}

// globalCompleteRegistration 一键注册激活：先查状态，需补地区则按默认地区（白名单首个，
// 通常 HK）提交后重新激活。activated 表示调用后账号已激活可用。幂等（已激活直接返回）。
// 失败不阻断调用方（panel login 已落库），仅返回错误供日志/消息。
export async function globalCompleteRegistration(a: AuthShape): Promise<boolean> {
  let st = await globalRegisterStatus(a);
  if (st.activated) return true;
  if (!st.needsRegion) throw new Error("register not activated: " + st.msg);
  // 需补地区：拉白名单，取首个（HK）提交。
  const countries = await globalFetchCountries(a, true);
  if (countries.length === 0) throw new Error("no countries available");
  try {
    await globalSubmitRegion(a, countries[0]);
  } catch (e) {
    throw new Error("submit region: " + (e instanceof Error ? e.message : String(e)));
  }
  // 重新激活验证。
  st = await globalRegisterStatus(a);
  if (!st.activated) {
    throw new Error("register still not activated after region submit: " + st.msg);
  }
  return true;
}