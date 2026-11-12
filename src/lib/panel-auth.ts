// 面板 API 公共辅助：统一响应形态 + BigInt 序列化兜底。
import { createHash, timingSafeEqual } from "crypto";

export const ok = (data: Record<string, unknown> = {}) =>
  jsonify({ ok: true, ...data }, 200);

export const fail = (status: number, msg: string) =>
  jsonify({ ok: false, error: msg }, status);

// jsonify Response.json 的 BigInt 安全版（Prisma BigInt 字段直接 JSON 化会抛错）。
export function jsonify(v: unknown, status = 200): Response {
  return new Response(
    JSON.stringify(v, (_, x) => (typeof x === "bigint" ? Number(x) : x)),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

// 面板入口与面板 API 均直接开放；超级密码仍用于指定的二次确认操作。
export async function panelAuth(_req: Request): Promise<Response | null> {
  return null;
}

// 超级密码：调整 key 的供应商授权时必须二次校验；未配置环境变量时一律拒绝。
// 比较走 SHA-256 摘要 + timingSafeEqual（与 Bearer 鉴权同口径）。

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

export function verifySuperPassword(input: unknown): boolean {
  if (typeof input !== "string" || input === "") return false;
  const expected = process.env.WB2A_SUPER_PASSWORD;
  if (!expected) return false;
  return timingSafeEqual(sha256(input), sha256(expected));
}
