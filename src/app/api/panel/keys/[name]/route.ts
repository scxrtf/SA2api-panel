// PATCH/DELETE /api/panel/keys/{name} — 调整供应商授权 / 删除网关密钥。
// PATCH 属于权限划分操作，必须携带超级密码二次确认。
import { panelAuth, verifySuperPassword, ok, fail } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { name } = await ctx.params;
  const existing = await prisma.apiKey.findUnique({ where: { name } });
  if (!existing) return fail(404, "未找到密钥：" + name);

  let body: { super_password?: unknown; providers?: unknown };
  try {
    body = (await req.json()) as { super_password?: unknown; providers?: unknown };
  } catch {
    return fail(400, "invalid json body");
  }
  if (!verifySuperPassword(body.super_password)) {
    return fail(403, "超级密码错误");
  }

  // providers 接收字符串数组（兼容逗号分隔字符串）；[] / "" / null / 缺省 =
  // 撤销全部授权（空 = 未授权任何供应商，fail closed，与新建密钥默认态一致）。
  let rawList: unknown[];
  if (body.providers === undefined || body.providers === null) {
    rawList = [];
  } else if (Array.isArray(body.providers)) {
    rawList = body.providers;
  } else if (typeof body.providers === "string") {
    rawList = body.providers.split(",");
  } else {
    return fail(400, "providers 必须是字符串数组");
  }
  if (!rawList.every((v) => typeof v === "string")) {
    return fail(400, "providers 必须是字符串数组");
  }

  const list: string[] = [];
  for (const item of rawList as string[]) {
    const v = item.trim();
    if (!v) continue;
    // "*" = 全部授权；与具体名单混用时可整体放行，忽略其余项。
    if (v === "*") {
      list.length = 0;
      list.push("*");
      break;
    }
    if (v.length > 64) return fail(400, "供应商名过长：" + v.slice(0, 64));
    if (!list.includes(v)) list.push(v);
  }

  // 绑定白名单时逐个核对供应商是否已注册，避免写出永不命中的幽灵授权。
  if (!list.includes("*") && list.length > 0) {
    const found = await prisma.provider.findMany({
      where: { name: { in: list } },
      select: { name: true },
    });
    const known = new Set(found.map((r) => r.name));
    const missing = list.filter((n) => !known.has(n));
    if (missing.length > 0) {
      return fail(400, "未知供应商：" + missing.join(", "));
    }
  }

  const stored = list.includes("*") ? "*" : list.join(",");
  await prisma.apiKey.update({ where: { name }, data: { providers: stored } });
  return ok({ name, providers: list });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { name } = await ctx.params;
  const existing = await prisma.apiKey.findUnique({ where: { name } });
  if (!existing) return fail(404, "未找到密钥：" + name);
  await prisma.apiKey.delete({ where: { name } });
  return ok();
}
