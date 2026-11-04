// POST .../remove — 移除账号（出池 + 删行；凭证不再保留）。
import { panelAuth, ok, fail } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";
import { runlogAccount } from "@/lib/runlog";
import { label } from "@/lib/logfmt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ uid: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { uid } = await ctx.params;
  const acct = await prisma.account.findUnique({ where: { uid } });
  if (!acct) return fail(404, "account not found");
  // 删除后昵称不可再查，先记录再删行。
  runlogAccount("移除", label(acct.uid, acct.nickname) + " realm=" + acct.realm);
  await prisma.account.delete({ where: { uid } });
  return ok();
}
