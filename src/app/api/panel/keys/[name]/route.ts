// DELETE /api/panel/keys/{name} — 删除网关密钥（主密钥本身不可经此删除）。
import { panelAuth, ok, fail } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

export async function DELETE(req: Request, ctx: Ctx) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { name } = await ctx.params;
  const existing = await prisma.apiKey.findUnique({ where: { name } });
  if (!existing) return fail(404, "未找到密钥：" + name);
  await prisma.apiKey.delete({ where: { name } });
  return ok();
}
