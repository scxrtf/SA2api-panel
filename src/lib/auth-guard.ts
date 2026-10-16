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
