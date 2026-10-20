// POST .../revive — 手动复活：清禁用 + 冷却 + 熔断（运维口径无条件恢复）。
import { panelAuth, ok, fail } from "@/lib/panel-auth";
import * as pool from "@/lib/pool";
import { runlogAccount } from "@/lib/runlog";
import { label } from "@/lib/logfmt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ uid: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { uid } = await ctx.params;
  const { prisma } = await import("@/lib/db");
  const acct = await prisma.account.findUnique({ where: { uid } });
  if (!acct) return fail(404, "account not found");
  await pool.revive(uid);
  runlogAccount("复活", label(acct.uid, acct.nickname));
  return ok();
}
