// GET/POST /api/panel/providers — 聚合供应商管理（key 只回掩码；新建整体入库）。
import { panelAuth, ok, fail } from "@/lib/panel-auth";
import { mask } from "@/lib/auth-guard";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const rows = await prisma.provider.findMany({ orderBy: { createdAt: "asc" } });
  return ok({
    providers: rows.map((r) => ({
      name: r.name,
      base_url: r.baseUrl,
      key_mask: mask(r.apiKey),
      models: r.models,
      created_at: r.createdAt,
    })),
  });
}

export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  let body: { name?: string; base_url?: string; key?: string; models?: string };
  try {
    body = (await req.json()) as { name?: string; base_url?: string; key?: string };
  } catch {
    return fail(400, "invalid json body");
  }
  const name = (body.name ?? "").trim();
  const baseUrl = (body.base_url ?? "").trim().replace(/\/+$/, "");
  const key = (body.key ?? "").trim();
  const models = (body.models ?? "").trim();
  if (!name || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    return fail(400, "供应商名仅限字母/数字/下划线/连字符（1-64 字符）");
  }
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) return fail(400, "base_url 必须是 http(s) URL");
  if (!key) return fail(400, "key 必填");
  const exists = await prisma.provider.findUnique({ where: { name } });
  if (exists) return fail(409, "同名供应商已存在");
  await prisma.provider.create({ data: { name, baseUrl, apiKey: key, models } });
  return ok({ name });
}
