// POST .../resume — 解除暂停选号（幂等）。
import { panelAuth, ok, fail } from "@/lib/panel-auth";
import * as pool from "@/lib/pool";

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
  await pool.resume(uid);
  return ok();
}
