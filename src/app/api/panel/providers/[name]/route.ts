// DELETE /api/panel/providers/{name} — 删除聚合供应商。
import { panelAuth, ok, fail } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

export async function DELETE(req: Request, ctx: Ctx) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { name } = await ctx.params;
  const existing = await prisma.provider.findUnique({ where: { name } });
  if (!existing) return fail(404, "未找到供应商：" + name);
  await prisma.provider.delete({ where: { name } });
  return ok();
}
