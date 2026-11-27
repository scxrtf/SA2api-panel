// 网关子密钥鉴权（移植 internal/httpauth）。SHA-256 摘要 + 常量时间比较。
import { createHash, timingSafeEqual } from "crypto";
import { prisma } from "./db";

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

function constTimeEq(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

// 密钥环进程内快照。原先 /api/v1/* 的每个请求都要扫两遍 ApiKey 全表
// （verifyAny 一遍、identifyKeyIdentity 一遍），是 Supabase egress 的主要来源之一。
// 30s TTL 覆盖突发流量；面板增删改密钥后立即失效（见 api/panel/keys 路由）。
// 缓存过期后 DB 异常则关闭子密钥访问，不把“查询失败”当作“未配置鉴权”。
const KEY_RING_TTL_MS = 30_000;
export interface KeyRingRow {
  name: string;
  key: string;
  providers: string;
}
type KeyRingCache = { at: number; rows: KeyRingRow[] };
const keyRingGlobals = globalThis as unknown as { __wbKeyRing?: KeyRingCache };
let keyRingGeneration = 0;
let pendingKeyRing: Promise<KeyRingRow[]> | null = null;

export function invalidateKeyRing(): void {
  delete keyRingGlobals.__wbKeyRing;
  keyRingGeneration++;
  pendingKeyRing = null;
}

async function loadKeyRing(): Promise<KeyRingRow[]> {
  const cached = keyRingGlobals.__wbKeyRing;
  if (cached && Date.now() - cached.at < KEY_RING_TTL_MS) return cached.rows.slice();
  if (pendingKeyRing) return (await pendingKeyRing).slice();
  const generation = keyRingGeneration;
  const pending = prisma.apiKey.findMany({
    select: { name: true, key: true, providers: true },
  }).then((rows) => {
    // 管理端删改密钥后，旧的在途快照不得重新写回缓存。
    if (generation === keyRingGeneration) keyRingGlobals.__wbKeyRing = { at: Date.now(), rows };
    return rows;
  }).finally(() => {
    if (pendingKeyRing === pending) pendingKeyRing = null;
  });
  pendingKeyRing = pending;
  return (await pending).slice();
}

// extractToken 提取请求凭证：优先 Authorization: Bearer，其次 x-api-key
// （Anthropic/Claude Code 客户端默认凭证头）。
export function extractToken(req: Request): string {
  const authz = req.headers.get("authorization") ?? "";
  const bearer = /^Bearer[ \t]+(.+)$/i.exec(authz)?.[1].trim();
  if (bearer) return bearer;
  const xkey = (req.headers.get("x-api-key") ?? "").trim();
  if (xkey) return xkey;
  return "";
}

// KeyIdentity 请求凭证的归属与供应商授权面。空密钥环时不限制；
// 子密钥按 providers 白名单判定，未授权任何供应商 = 全拒绝（DB 异常同样 fail closed）。
export interface KeyIdentity {
  name: string;
  providers: string;
  unrestricted: boolean;
}

// parseProviderAccess 解析 ApiKey.providers 存储串：
//   "*"        → ["*"]（全部供应商）
//   ""         → []（未授权任何供应商；新建密钥的默认态）
//   "foo,bar"  → ["foo", "bar"]
export function parseProviderAccess(raw: string): string[] {
  const s = (raw ?? "").trim();
  if (!s) return [];
  const parts = s.split(",").map((v) => v.trim()).filter(Boolean);
  if (parts.includes("*")) return ["*"];
  return Array.from(new Set(parts));
}

// providerAllowed 判断指定供应商是否在该 key 的授权名单内。
// 未授权任何供应商（空串）→ 一律拒绝（fail closed）；"*" → 全部放行。
export function providerAllowed(providersRaw: string, provider: string): boolean {
  const list = parseProviderAccess(providersRaw);
  // 未授权任何供应商 = 拒绝（新建密钥默认态，需在面板显式勾选）。
  if (list.length === 0) return false;
  return list.includes("*") || list.includes(provider);
}

// identifyKeyIdentity：空密钥环 → unrestricted；命中 ApiKey 环 → name + providers；
// 无法识别或 DB 异常 → null。网站面板不使用此鉴权。
export async function identifyKeyIdentity(req: Request): Promise<KeyIdentity | null> {
  const tok = extractToken(req);
  let rows: KeyRingRow[] = [];
  let dbOk = true;
  try {
    rows = await loadKeyRing();
  } catch {
    dbOk = false;
  }
  // 空密钥环 = 免密钥模式；未带凭证时可识别为空环用户。
  if (dbOk && rows.length === 0) {
    return { name: "", providers: "*", unrestricted: true };
  }
  if (!tok) return null;
  for (const r of rows) {
    if (r.key && constTimeEq(tok, r.key)) {
      return { name: r.name || mask(r.key), providers: r.providers ?? "", unrestricted: false };
    }
  }
  return null;
}

// providerAllowlist 把身份折算成供应商白名单：
//   null       = 不限制（空密钥环 / 子密钥显式 "*"）
//   空集合     = 禁止所有供应商（子密钥未授权任何供应商 / 身份缺失，fail closed）
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

// verifyAny 校验凭证是否命中 ApiKey 环；密钥环为空时恒 true。
// 全部为空 = 未启用鉴权，恒 true（与 Go VerifyAny 同语义）。
export async function verifyAny(req: Request): Promise<boolean> {
  return (await identifyKeyIdentity(req)) !== null;
}

// mask 密钥展示脱敏：前 4 后 4，中间打码。
export function mask(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}
