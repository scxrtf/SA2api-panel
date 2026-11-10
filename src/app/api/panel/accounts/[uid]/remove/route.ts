// POST .../remove — 移除账号（出池 + 删行；凭证不再保留）。
// 移除为权限级操作：与密钥删除同口径，超级密码二次确认。
import { panelAuth, verifySuperPassword, ok, fail } from "@/lib/panel-auth";
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
  let body: { super_password?: unknown } = {};
  try {
    body = (await req.json()) as { super_password?: unknown };
  } catch {
    return fail(400, "invalid json body");
  }
  if (!verifySuperPassword(body.super_password)) {
    return fail(403, "超级密码错误");
  }
  const acct = await prisma.account.findUnique({ where: { uid } });
  if (!acct) return fail(404, "account not found");
  // 删除后昵称不可再查，先记录再删行。
  runlogAccount("移除", label(acct.uid, acct.nickname) + " realm=" + acct.realm);
  await prisma.account.delete({ where: { uid } });
  return ok();
}
