// GET/POST /api/panel/keys — 网关密钥环管理（列表只回掩码；POST 新建返回原文一次）。
import { randomBytes } from "crypto";
import { panelAuth, ok, fail } from "@/lib/panel-auth";
import { mask } from "@/lib/auth-guard";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const rows = await prisma.apiKey.findMany({ orderBy: { createdAt: "asc" } });
  return ok({
    keys: rows.map((r) => ({ name: r.name, key_mask: mask(r.key), created_at: r.createdAt })),
  });
}

export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  let body: { name?: string };
  try {
    body = (await req.json()) as { name?: string };
  } catch {
    return fail(400, "invalid json body");
  }
  const name = (body.name ?? "").trim();
  if (!name || name.length > 64) return fail(400, "name 必填且不超过 64 字符");
  const exists = await prisma.apiKey.findUnique({ where: { name } });
  if (exists) return fail(409, "同名密钥已存在");
  const key = "sk-" + randomBytes(24).toString("hex");
  await prisma.apiKey.create({ data: { name, key } });
  // 原文仅在此响应出现一次，前端需提示用户保存。
  return ok({ name, key });
}
