// PATCH/DELETE /api/panel/providers/{name} — 修改 / 删除聚合供应商。
// 权限级操作：必须携带超级密码；同事务内从所有网关密钥的 providers 白名单里
// 剔除该供应商，避免密钥残留指向已不存在供应商的幽灵授权（重新保存时 400）。
import { panelAuth, verifySuperPassword, ok, fail } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

// PATCH 修改供应商的可编辑字段（models 白名单 / base_url / key）。
// key 留空 = 不更换；name 为主键不可改（改名等于新建+删旧）。
export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { name } = await ctx.params;
  let body: { models?: string; base_url?: string; key?: string };
  try {
    body = (await req.json()) as { models?: string; base_url?: string; key?: string };
  } catch {
    return fail(400, "invalid json body");
  }
  const existing = await prisma.provider.findUnique({ where: { name } });
  if (!existing) return fail(404, "未找到供应商：" + name);

  const data: { models?: string; baseUrl?: string; apiKey?: string } = {};
  if (body.models !== undefined) data.models = body.models.trim();
  if (body.base_url !== undefined) {
    const baseUrl = body.base_url.trim().replace(/\/+$/, "");
    if (!baseUrl || !/^https?:\/\//.test(baseUrl)) return fail(400, "base_url 必须是 http(s) URL");
    data.baseUrl = baseUrl;
  }
  if (body.key !== undefined && body.key.trim()) data.apiKey = body.key.trim();
  if (Object.keys(data).length === 0) return fail(400, "没有可更新的字段");

  await prisma.provider.update({ where: { name }, data });
  return ok({ name });
}

// stripProvider 从逗号分隔的授权串里移除目标供应商；"*" 保持不变（不含具体名）。
function stripProvider(stored: string, target: string): string {
  const list = stored.split(",").map((s) => s.trim()).filter(Boolean);
  if (list.includes("*")) return "*";
  return list.filter((s) => s !== target).join(",");
}

export async function DELETE(req: Request, ctx: Ctx) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { name } = await ctx.params;

  // 超级密码来源：JSON body.super_password 或 ?super_password=（DELETE 部分客户端不便带 body）。
  let pw: unknown = new URL(req.url).searchParams.get("super_password");
  if (pw === null || pw === "") {
    try {
      const body = (await req.json()) as { super_password?: unknown };
      pw = body.super_password;
    } catch { /* 无 body 时保持 null，由下方统一判 403 */ }
  }
  if (!verifySuperPassword(pw)) return fail(403, "超级密码错误");

  const existing = await prisma.provider.findUnique({ where: { name } });
  if (!existing) return fail(404, "未找到供应商：" + name);

  const result = await prisma.$transaction(async (tx) => {
    // 先清理引用：所有授权串里含该供应商名的 key 都重写（剔除该名）。
    const keys = await tx.apiKey.findMany({
      where: { providers: { contains: name } },
      select: { name: true, providers: true },
    });
    let scrubbed = 0;
    for (const k of keys) {
      const next = stripProvider(k.providers, name);
      if (next !== k.providers) {
        await tx.apiKey.update({ where: { name: k.name }, data: { providers: next } });
        scrubbed++;
      }
    }
    await tx.provider.delete({ where: { name } });
    return scrubbed;
  });
  return ok({ scrubbed_keys: result });
}
