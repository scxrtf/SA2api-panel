// 网关与面板共用的 Bearer 鉴权原语（移植 internal/httpauth）。
// 口径与 Go 完全一致：SHA-256 摘要 + 常量时间比较，空 key = 不启用鉴权。
import { createHash, timingSafeEqual } from "crypto";
import { prisma } from "./db";
import { getConfig } from "./config";

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

function constTimeEq(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

// extractToken 提取请求凭证：优先 Authorization: Bearer，其次 x-api-key
// （Anthropic/Claude Code 客户端默认凭证头）。
export function extractToken(req: Request): string {
  const authz = req.headers.get("authorization") ?? "";
  if (authz.startsWith("Bearer ") && authz.length > 7) {
    return authz.slice(7);
  }
  const xkey = (req.headers.get("x-api-key") ?? "").trim();
  if (xkey) return xkey;
  return "";
}

// verifyBearer 校验主密钥。key 为空 = 未启用鉴权，恒 true。
export function verifyBearer(req: Request, key: string): boolean {
  if (!key) return true;
  return constTimeEq(extractToken(req), key);
}

// KeyIdentity 请求凭证的归属与供应商授权面。unrestricted 仅用于主密钥 / 未启用
// 鉴权的部署；子密钥一律按 providers 白名单判定（DB 异常时 fail closed）。
export interface KeyIdentity {
  name: string;
  providers: string;
  unrestricted: boolean;
}

// parseProviderAccess 解析 ApiKey.providers 存储串：
//   "*"        → ["*"]
//   ""         → []（全部禁止）
//   "foo,bar"  → ["foo", "bar"]
export function parseProviderAccess(raw: string): string[] {
  const s = (raw ?? "").trim();
  if (!s) return [];
  const parts = s.split(",").map((v) => v.trim()).filter(Boolean);
  if (parts.includes("*")) return ["*"];
  return Array.from(new Set(parts));
}

// providerAllowed 判断指定供应商是否在该 key 的授权名单内。
export function providerAllowed(providersRaw: string, provider: string): boolean {
  const list = parseProviderAccess(providersRaw);
  return list.includes("*") || list.includes(provider);
}

// identifyKeyIdentity 识别请求凭证：主密钥 / 未启用鉴权 → unrestricted；
// 命中 ApiKey 环 → 返回该行的 name + providers；无法识别或 DB 异常 → null。
export async function identifyKeyIdentity(req: Request): Promise<KeyIdentity | null> {
  const tok = extractToken(req);
  const cfg = await getConfig();
  let rows: { name: string; key: string; providers: string }[] = [];
  let dbOk = true;
  try {
    rows = await prisma.apiKey.findMany({ select: { name: true, key: true, providers: true } });
  } catch {
    dbOk = false;
  }
  // 未启用鉴权（主密钥为空且 key 环为空）：全部放行。
  if (dbOk && !cfg.api_key && rows.length === 0) {
    return { name: "", providers: "*", unrestricted: true };
  }
  if (!tok) return null;
  if (cfg.api_key && constTimeEq(tok, cfg.api_key)) {
    return { name: "", providers: "*", unrestricted: true };
  }
  for (const r of rows) {
    if (r.key && constTimeEq(tok, r.key)) {
      return { name: r.name || mask(r.key), providers: r.providers ?? "", unrestricted: false };
    }
  }
  return null;
}

// providerAllowlist 把身份折算成供应商白名单：
//   null       = 不限制（主密钥 / 未启用鉴权 / 子密钥显式 "*"）
//   空集合     = 禁止所有供应商（身份缺失也按空集合处理，fail closed）
export function providerAllowlist(id: KeyIdentity | null): Set<string> | null {
  if (!id) return new Set();
  if (id.unrestricted) return null;
  const list = parseProviderAccess(id.providers);
  if (list.includes("*")) return null;
  return new Set(list);
}

// identifyKeyName 识别请求凭证的 key 归属名（多 sk-key 模式）：命中 ApiKey 环
// 中某把 key 时返回其 name（name 空时回落掩码，对齐 Go keyring.Identify）。
// 单 key 模式 / 未携带 / DB 不可用时返回空串（归档字段自动省略，零回归）。
export async function identifyKeyName(req: Request): Promise<string> {
  const id = await identifyKeyIdentity(req);
  return id?.name ?? "";
}

// verifyAny 校验凭证是否命中 主密钥 ∪ ApiKey 环 中的任意一把。
// 全部为空 = 未启用鉴权，恒 true（与 Go VerifyAny 同语义）。
export async function verifyAny(req: Request): Promise<boolean> {
  const cfg = await getConfig();
  const keys: string[] = [];
  if (cfg.api_key) keys.push(cfg.api_key);
  try {
    const rows = await prisma.apiKey.findMany({ select: { key: true } });
    for (const r of rows) if (r.key) keys.push(r.key);
  } catch {
    // DB 不可用时仅按主密钥判定。
  }
  if (keys.length === 0) return true;
  const tok = extractToken(req);
  let matched = false;
  for (const k of keys) {
    if (constTimeEq(tok, k)) matched = true;
  }
  return matched;
}

// mask 密钥展示脱敏：前 4 后 4，中间打码。
export function mask(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}
