// 面板 API 公共辅助：主密钥鉴权 + 统一响应形态 + BigInt 序列化兜底。
import { verifyBearer } from "./auth-guard";
import { getConfig } from "./config";

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

// panelAuth 面板鉴权：主密钥为空 = 放行（与 Go 同语义）。非 null 即拒绝。
export async function panelAuth(req: Request): Promise<Response | null> {
  const cfg = await getConfig();
  if (!verifyBearer(req, cfg.api_key)) return fail(401, "invalid_api_key");
  return null;
}
